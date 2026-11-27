/**
 * MTV Source Converter — Cloudflare Workers 入口
 *
 * 架构：
 *   Cron Trigger（每 2h）  →  fetch ziyuanzu.com → 转换 → Base58 编码 → 写 KV
 *   fetch handler          →  读 KV 直接返回（零上游依赖，CPU < 1 ms）
 *   兜底                    →  KV 为空时在请求内实时抓取一次并回写
 *
 * 为什么 Base58 在 Cron 里算而不是在请求里算：
 *   一份 73 站的配置序列化后约 6.3 KB，Base58 编码（本项目用的分块实现）约 14 ms
 *   CPU。Workers 免费套餐每次调用只有 10 ms CPU 预算，放在请求路径里必然触发
 *   error 1102。放进 Cron 只算一次，请求只读字符串，订阅接口才不会 5xx。
 *
 * 路由与 Python 版 server.py 对齐：
 *   GET /                   状态页
 *   GET /config.json        全部站点（Base58 编码，MoonTVPlus 订阅格式）
 *   GET /config-safe.json   屏蔽成人版（Base58）
 *   GET /config.txt         TVBox TXT 全部
 *   GET /config-safe.txt    TVBox TXT 屏蔽版
 *   GET /health             健康检查
 *   GET /stats              统计 + 源列表
 *   POST /refresh           手动触发抓取（需 ADMIN_TOKEN）
 */
import { base58Encode } from './base58';
import {
  convertToMoonTVPlus,
  convertToTvbox,
  mergeSites,
  siteDomain,
  sourceSummary,
  type SourceGroup,
  type SourcedSite,
} from './converter';
import { fetchSites, probeMany } from './fetcher';
import {
  readConfigB58,
  readConfigJson,
  readMeta,
  readProbe,
  readTvbox,
  writeConfigB58,
  writeError,
  writeProbe,
  writeSnapshot,
  type Meta,
  type ProbeState,
} from './store';

/**
 * Cron 排班（UTC，换算成北京时间写在注释里）。
 *
 * 抓取每天两次：北京 13:00 和 次日 01:00
 *   北京 13:00 = UTC 05:00
 *   北京 01:00 = UTC 17:00（前一天）
 * 用「小时列表」把两个时刻塞进同一个表达式：`0 5,17 * * *`。
 *
 * 为什么只有一个表达式：Cloudflare 免费账号全账号只有 5 个 cron trigger，
 * 这台账号上别的 Worker 已经占了 4 个，本 Worker 只能用 1 个。
 * 代价是两次 Base58 编码都要在同一次调用里做完（约 28 ms CPU），
 * 实测在免费套餐上能过（运行时对「偶发超出」有容错）；真被 kill 的话
 * writeSnapshot 是原子的，KV 保留上一次的好数据，订阅不会中断。
 */
const CRON_REFRESH = ['0 5,17 * * *'];

export interface Env {
  CONFIG: KVNamespace;
  SOURCE_URL: string;
  /** 逗号分隔的额外源，支持裸数组 / MoonTVPlus JSON / Base58 订阅串 */
  EXTRA_SOURCES: string;
  CACHE_TIME: string;
  FETCH_TIMEOUT: string;
  FETCH_RETRIES: string;
  STALE_IF_ERROR_HOURS: string;
  /** 是否开启源可用性探测 */
  PROBE_ENABLED: string;
  /** 单次调用探测多少个源（受 Workers 每请求 50 个 subrequest 限制） */
  PROBE_LIMIT: string;
  PROBE_TIMEOUT: string;
  /** 连续失败多少次就从输出里剔除 */
  PROBE_FAIL_THRESHOLD: string;
  ADMIN_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isRefresh = path === '/refresh';
    const isProbe = path === '/probe';

    // /refresh 和 /probe 只接受 POST（GET 带 token 也能触发的写法会把写动作暴露给预取/爬虫）
    if (isRefresh || isProbe) {
      if (req.method !== 'POST') {
        return json({ error: 'method not allowed', allow: 'POST' }, 405, { allow: 'POST' });
      }
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, 405);
    }

    try {
      switch (path) {
        case '/':
          return html(await renderIndex(env));
        case '/config.json':
          return await subscription(env, true);
        case '/config-safe.json':
          return await subscription(env, false);
        case '/config.txt':
          return await tvbox(env, true);
        case '/config-safe.txt':
          return await tvbox(env, false);
        case '/health':
          return json(await health(env));
        case '/stats':
          return json(await stats(env));
        case '/sources':
          return json(await sourcesReport(env));
        case '/refresh': {
          const r = await manualRefresh(req, env);
          return json(r.body, r.status, { 'cache-control': 'no-store' });
        }
        case '/probe': {
          const r = await manualProbe(req, env);
          return json(r.body, r.status, { 'cache-control': 'no-store' });
        }
        default:
          return json({ error: 'not found', path: url.pathname }, 404);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: 'internal error', detail: msg }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 排班表里的表达式走标准流程；已写不匹配的（比如在 Dashboard 手动改过）也照抓，不静默跳过
    const trigger = CRON_REFRESH.includes(controller.cron) ? 'cron' : `cron:${controller.cron}`;
    ctx.waitUntil(refresh(env, trigger, 'both'));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// 订阅输出（KV 命中即返回；未命中才触发一次抓取）
// ---------------------------------------------------------------------------

/** 编码哪几份产物：Cron 一次一份，冷启动只做被请求的那一份，TVBox 路径一份都不编 */
type EncodeTarget = 'both' | 'full' | 'safe' | 'none';

/** 冷启动失败后的冷却时间：上游挂了的时候别让每个请求都去打一遍上游（3 次重试 + 14s 退避） */
const COOLDOWN_MS = 60_000;

/**
 * 冷却只在「上一次尝试是失败」时生效：上游挂了的时候别让每个请求都去打一遍
 * 上游（3 次重试 + 14s 退避）。抓取成功会把 last_error 清空，所以正常状态下
 * 不会误伤「刚被 /config.txt 拉过数据、紧接着访问 /config.json」这种场景。
 */
function coolingDown(meta: Meta): boolean {
  if (!meta.last_error || !meta.last_attempt_at) return false;
  const age = Date.now() - Date.parse(meta.last_attempt_at);
  return Number.isFinite(age) && age >= 0 && age < COOLDOWN_MS;
}

function notReady(detail: string, retryAfter = 60): Response {
  return json(
    {
      error: 'config not ready',
      detail,
      hint: '稍后重试；或检查 SOURCE_URL / Cron 是否正常',
    },
    503,
    { 'retry-after': String(retryAfter), 'cache-control': 'no-store' },
  );
}

async function subscription(env: Env, full: boolean): Promise<Response> {
  const cached = await readConfigB58(env.CONFIG, full);
  if (cached) return text(cached);

  // 明文已经在 KV 里，只是缺 Base58（比如刚部署、或另一条路径抓过数据）：
  // 直接就地编码，不再打一次上游。这一次调用约 14 ms CPU，属于冷启动兜底的成本。
  const cfg = await readConfigJson(env.CONFIG, full);
  if (Object.keys(cfg.api_site).length > 0) {
    const encoded = base58Encode(JSON.stringify(cfg));
    await writeConfigB58(env.CONFIG, full, encoded);
    return text(encoded);
  }

  // KV 完全是空的：抓一次，只编码这一份。刚失败过就先别打上游
  const meta = await readMeta(env.CONFIG);
  if (coolingDown(meta)) return notReady(meta.last_error || '上次抓取刚失败，冷却中');

  const result = await refresh(env, 'cold-start', full ? 'full' : 'safe');
  const after = result.ok ? await readConfigB58(env.CONFIG, full) : null;
  if (after) return text(after);

  return notReady(result.error ?? '上游抓取失败，KV 中也没有旧数据');
}

async function tvbox(env: Env, full: boolean): Promise<Response> {
  const cached = await readTvbox(env.CONFIG, full);
  if (cached) return text(cached);

  const meta = await readMeta(env.CONFIG);
  if (coolingDown(meta)) return notReady(meta.last_error || '上次抓取刚失败，冷却中');

  const result = await refresh(env, 'cold-start', 'none');
  const after = result.ok ? await readTvbox(env.CONFIG, full) : null;
  if (after) return text(after);

  return notReady(result.error ?? '上游抓取失败，KV 中也没有旧数据');
}

// ---------------------------------------------------------------------------
// 抓取 + 转换 + 写入
// ---------------------------------------------------------------------------

export interface RefreshResult {
  ok: boolean;
  siteCount: number;
  safeCount: number;
  /** 被探测结果剔除掉的源数量 */
  filteredCount: number;
  /** 每个上游贡献了多少站、去重后留下多少 */
  sources: Record<string, { fetched: number; kept: number }>;
  probe?: ProbeReport;
  error?: string;
  attempts: number;
  elapsedMs: number;
}

interface ProbeReport {
  tested: number;
  alive: number;
  /** 硬证据失败（4xx / RSS 接口不兼容） */
  hard_failed: number;
  /** 软证据失败（超时 / 连接失败 / 5xx），不计入剔除 */
  soft_failed: number;
  /** 还有多少个源从没被测过 */
  never_tested: number;
  /** 当前会被剔除的源数量 */
  pruned: number;
}

/** 主源 + EXTRA_SOURCES 拼成有序源列表，主源永远排第一（去重时优先保留） */
function buildSources(env: Env): { label: string; url: string }[] {
  const list = [{ label: 'main', url: env.SOURCE_URL }];
  const extras = (env.EXTRA_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  extras.forEach((url, i) => list.push({ label: `extra${i + 1}`, url }));
  return list;
}

/**
 * 抓取所有源 → 按域名合并去重 → 剔除已知死源 → 转换 → 编码 → 写 KV → 探测下一批。
 *
 * 只有主源失败才算整次刷新失败；额外源挂了只影响它那部分站点（旧数据还在 KV 里，
 * 订阅继续可用），这是「多源」必须的行为 —— 不能因为一个第三方订阅挂了就把整个服务打挂。
 */
export async function refresh(
  env: Env,
  trigger: string,
  encode: EncodeTarget = 'both',
): Promise<RefreshResult> {
  const started = Date.now();
  const timeoutMs = Number(env.FETCH_TIMEOUT ?? 30) * 1000;
  const retries = Number(env.FETCH_RETRIES ?? 3);
  const cacheTime = Number(env.CACHE_TIME ?? 7200);

  const sources = buildSources(env);

  const fetched = await Promise.all(
    sources.map(async (s) => ({
      label: s.label,
      url: s.url,
      res: await fetchSites(s.url, timeoutMs, retries),
    })),
  );

  const main = fetched[0];
  if (!main.res.ok) {
    const error = main.res.error ?? 'unknown';
    // 只写错误信息，保留下次成功时的数据继续对外服务
    await writeError(env.CONFIG, `[${trigger}] ${error}`);
    return {
      ok: false, siteCount: 0, safeCount: 0, filteredCount: 0, sources: {},
      error, attempts: main.res.attempts, elapsedMs: main.res.elapsedMs,
    };
  }

  const groups: SourceGroup[] = fetched
    .filter((f) => f.res.ok && f.res.sites.length > 0)
    .map((f) => ({ label: f.label, sites: f.res.sites }));
  const merged = mergeSites(groups);

  // ---- 用上次探测结果剔除死源 ----
  const probeEnabled = String(env.PROBE_ENABLED ?? 'true') !== 'false';
  const threshold = Math.max(1, Number(env.PROBE_FAIL_THRESHOLD ?? 2));
  const probeState = probeEnabled ? await readProbe(env.CONFIG) : { updated_at: '', cursor: 0, entries: {} };

  const usable = probeEnabled
    ? merged.filter((s) => {
        const e = probeState.entries[s.domain];
        return !e || e.fails < threshold;
      })
    : merged;
  const filteredCount = merged.length - usable.length;

  const configFull = convertToMoonTVPlus(usable, cacheTime, false);
  const configSafe = convertToMoonTVPlus(usable, cacheTime, true);
  const tvboxFull = convertToTvbox(usable, false);
  const tvboxSafe = convertToTvbox(usable, true);

  // Base58 编码是这里最贵的一步（约 14 ms/份）。Cron 第一跳只编「全部版」，
  // 第二跳才补「屏蔽版」；冷启动只编被请求的那一份；TVBox 路径一份都不编。
  // 没算的那份传 undefined，让 writeSnapshot 跳过写入，保留 KV 里的旧值。
  const configFullB58 =
    encode === 'both' || encode === 'full' ? base58Encode(JSON.stringify(configFull)) : undefined;
  const configSafeB58 =
    encode === 'both' || encode === 'safe' ? base58Encode(JSON.stringify(configSafe)) : undefined;

  await writeSnapshot(
    env.CONFIG,
    { configFull, configSafe, configFullB58, configSafeB58, tvboxFull, tvboxSafe },
    {
      site_count: Object.keys(configFull.api_site).length,
      safe_count: Object.keys(configSafe.api_site).length,
      filtered_count: filteredCount,
      source_stats: sourceSummary(groups, merged),
      last_duration_ms: Date.now() - started,
      last_attempts: main.res.attempts,
      source_url: env.SOURCE_URL,
    },
  );

  // ---- 探测下一批（写完 KV 才做，探测失败不影响发布）----
  let probe: ProbeReport | undefined;
  if (probeEnabled && encode !== 'none' && merged.length > 0) {
    try {
      probe = await runProbeBatch(env, merged, probeState);
    } catch {
      // 探测是增强功能，任何异常都不该让这次刷新算失败
    }
  }

  return {
    ok: true,
    siteCount: Object.keys(configFull.api_site).length,
    safeCount: Object.keys(configSafe.api_site).length,
    filteredCount,
    sources: sourceSummary(groups, merged),
    probe,
    attempts: main.res.attempts,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 探测一批源的可用性并落盘。
 *
 * 优先测「从没测过」的（last_at 为空），其次测「最久没测」的，天然实现轮转覆盖。
 * 数量受 Workers「每请求 50 个 subrequest」限制：这里默认 25 个，
 * 加上抓源（1+N）、KV 读写（约 9 次）仍有余量。
 */
async function runProbeBatch(env: Env, sites: SourcedSite[], state: ProbeState): Promise<ProbeReport> {
  const limit = Math.max(1, Math.min(40, Number(env.PROBE_LIMIT ?? 25)));
  const timeoutMs = Math.max(1, Number(env.PROBE_TIMEOUT ?? 8)) * 1000;

  const ordered = [...sites].sort((a, b) => {
    const ea = state.entries[a.domain]?.last_at ?? '';
    const eb = state.entries[b.domain]?.last_at ?? '';
    if (ea === eb) return a.domain.localeCompare(b.domain);
    return ea < eb ? -1 : 1;
  });

  const batch = ordered.slice(0, limit);
  const outcomes = await probeMany(
    batch.map((s) => ({ key: s.domain, api: s.api ?? '' })),
    timeoutMs,
  );

  const now = new Date().toISOString();
  const entries = { ...state.entries };
  let alive = 0;
  let hardFailed = 0;
  let softFailed = 0;

  // 只有「硬证据」才累计 fails 并可能被剔除。超时/连接失败/TLS 错误
  // 单独记在 soft 里 —— 探测端自己网络不通（尤其国内直连）会把这些全打红，
  // 直接拿来剔除等于把好源误杀。
  for (const [domain, r] of Object.entries(outcomes)) {
    const prev = entries[domain];
    const hard = !r.ok && r.weight === 'hard';
    const soft = !r.ok && r.weight === 'soft';
    entries[domain] = {
      ok: r.ok,
      fails: r.ok ? 0 : (prev?.fails ?? 0) + (hard ? 1 : 0),
      soft: r.ok ? 0 : (prev?.soft ?? 0) + (soft ? 1 : 0),
      code: r.code,
      detail: r.detail.slice(0, 120),
      ms: r.ms,
      last_at: now,
    };
    if (r.ok) alive++;
    else if (hard) hardFailed++;
    else softFailed++;
  }

  await writeProbe(env.CONFIG, { updated_at: now, cursor: 0, entries });

  const threshold = Math.max(1, Number(env.PROBE_FAIL_THRESHOLD ?? 2));
  const never = sites.filter((s) => !entries[s.domain]).length;
  const pruned = sites.filter((s) => (entries[s.domain]?.fails ?? 0) >= threshold).length;

  return {
    tested: batch.length,
    alive,
    hard_failed: hardFailed,
    soft_failed: softFailed,
    never_tested: never,
    pruned,
  };
}

// ---------------------------------------------------------------------------
// 页面 / 端点
// ---------------------------------------------------------------------------

// 手动刷新：POST，需要 ADMIN_TOKEN（X-Admin-Token 头优先，兼容 ?token=）
async function manualRefresh(req: Request, env: Env): Promise<{ body: Record<string, unknown>; status: number }> {
  const url = new URL(req.url);
  const given = req.headers.get('x-admin-token') || url.searchParams.get('token') || '';
  if (!env.ADMIN_TOKEN) {
    return { body: { error: 'ADMIN_TOKEN 未配置，手动刷新已禁用（Cron 仍正常运行）' }, status: 403 };
  }
  if (given !== env.ADMIN_TOKEN) {
    return { body: { error: 'invalid admin token' }, status: 401 };
  }

  const result = await refresh(env, 'manual', 'both');
  return {
    status: result.ok ? 200 : 502,
    body: {
      ok: result.ok,
      site_count: result.siteCount,
      safe_count: result.safeCount,
      filtered_count: result.filteredCount,
      sources: result.sources,
      probe: result.probe ?? null,
      attempts: result.attempts,
      elapsed_ms: result.elapsedMs,
      error: result.error ?? null,
    },
  };
}

/** 手动探测：POST /probe，只跑可用性探测，不重新抓上游 */
async function manualProbe(req: Request, env: Env): Promise<{ body: Record<string, unknown>; status: number }> {
  if (!env.ADMIN_TOKEN) {
    return { body: { error: 'ADMIN_TOKEN 未配置，手动探测已禁用' }, status: 403 };
  }
  const url = new URL(req.url);
  const given = req.headers.get('x-admin-token') || url.searchParams.get('token') || '';
  if (given !== env.ADMIN_TOKEN) {
    return { body: { error: 'invalid admin token' }, status: 401 };
  }

  // 从 KV 里的明文配置反推站点列表（含域名），不重新抓上游
  const cfg = await readConfigJson(env.CONFIG, true);
  const sites: SourcedSite[] = Object.entries(cfg.api_site).map(([, v]) => ({
    name: v.name,
    api: v.api,
    source: 'kv',
    domain: siteDomain({ api: v.api }),
  })).filter((s) => s.domain && /^https?:\/\//i.test(s.api));

  if (sites.length === 0) {
    return { body: { error: 'KV 里还没有站点，先跑一次 /refresh' }, status: 409 };
  }

  const state = await readProbe(env.CONFIG);
  const report = await runProbeBatch(env, sites, state);
  return {
    status: 200,
    body: { ok: true, total_sites: sites.length, ...report },
  };
}

/** GET /sources：看每个源的探测结果，方便判断哪个上游在拖后腿 */
async function sourcesReport(env: Env): Promise<Record<string, unknown>> {
  const [meta, configFull, probe] = await Promise.all([
    readMeta(env.CONFIG),
    readConfigJson(env.CONFIG, true),
    readProbe(env.CONFIG),
  ]);
  const threshold = Math.max(1, Number(env.PROBE_FAIL_THRESHOLD ?? 2));
  const rows = Object.entries(configFull.api_site).map(([key, v]) => {
    const domain = siteDomain({ api: v.api });
    const e = probe.entries[domain];
    return {
      key,
      domain,
      name: v.name,
      api: v.api,
      state: !e ? 'untested' : e.ok ? 'alive' : e.fails >= threshold ? 'dead' : e.code === 'network' || e.code === 'timeout' ? 'unreachable' : 'flaky',
      fails: e?.fails ?? 0,
      soft: e?.soft ?? 0,
      code: e?.code ?? null,
      detail: e?.detail ?? null,
      last_ms: e?.ms ?? null,
      last_probe: e?.last_at || null,
    };
  });

  const counts = { alive: 0, flaky: 0, unreachable: 0, dead: 0, untested: 0 };
  for (const r of rows) counts[r.state as keyof typeof counts]++;

  return {
    probe_updated_at: probe.updated_at || null,
    probe_enabled: String(env.PROBE_ENABLED ?? 'true') !== 'false',
    fail_threshold: threshold,
    extra_sources: buildSources(env).slice(1).map((s) => s.url),
    source_stats: meta.source_stats,
    filtered_from_output: meta.filtered_count,
    counts,
    sites: rows,
  };
}

/** 数据超过 STALE_IF_ERROR_HOURS 未更新就标记 stale，方便外部监控 */
function staleness(meta: Meta, staleHours: number): { stale: boolean; ageSeconds: number | null } {
  if (!meta.last_updated) return { stale: false, ageSeconds: null };
  const age = Date.now() - Date.parse(meta.last_updated);
  if (!Number.isFinite(age)) return { stale: false, ageSeconds: null };
  return { stale: age > staleHours * 3600 * 1000, ageSeconds: Math.round(age / 1000) };
}

async function health(env: Env): Promise<Record<string, unknown>> {
  const meta = await readMeta(env.CONFIG);
  const staleHours = Number(env.STALE_IF_ERROR_HOURS ?? 72);
  const { stale, ageSeconds } = staleness(meta, staleHours);
  return {
    status: meta.site_count === 0 ? 'starting' : stale ? 'stale' : 'ok',
    sites: meta.site_count,
    safe_sites: meta.safe_count,
    filtered: meta.filtered_count,
    sources: meta.source_stats,
    last_updated: meta.last_updated || null,
    age_seconds: ageSeconds,
    stale_after_hours: staleHours,
    fetch_count: meta.fetch_count,
    error_count: meta.error_count,
    last_error: meta.last_error || null,
  };
}

async function stats(env: Env): Promise<Record<string, unknown>> {
  const [meta, configFull, configSafe, probe] = await Promise.all([
    readMeta(env.CONFIG),
    readConfigJson(env.CONFIG, true),
    readConfigJson(env.CONFIG, false),
    readProbe(env.CONFIG),
  ]);
  const toList = (cfg: typeof configFull) =>
    Object.entries(cfg.api_site).map(([key, v]) => ({ key, name: v.name, api: v.api }));

  const threshold = Math.max(1, Number(env.PROBE_FAIL_THRESHOLD ?? 2));
  const entries = Object.values(probe.entries);
  const probeSummary = {
    enabled: String(env.PROBE_ENABLED ?? 'true') !== 'false',
    fail_threshold: threshold,
    updated_at: probe.updated_at || null,
    probed: entries.length,
    alive: entries.filter((e) => e.ok).length,
    flaky: entries.filter((e) => !e.ok && e.fails < threshold && e.code !== 'network' && e.code !== 'timeout').length,
    unreachable: entries.filter((e) => !e.ok && (e.code === 'network' || e.code === 'timeout')).length,
    dead: entries.filter((e) => !e.ok && e.fails >= threshold).length,
    soft_failures: entries.filter((e) => !e.ok && e.soft > 0).length,
  };

  return {
    ...meta,
    cache_time: configFull.cache_time,
    probe: probeSummary,
    total_sources: toList(configFull),
    safe_sources: toList(configSafe),
  };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function renderIndex(env: Env): Promise<string> {
  const [meta, probe] = await Promise.all([readMeta(env.CONFIG), readProbe(env.CONFIG)]);
  const staleHours = Number(env.STALE_IF_ERROR_HOURS ?? 72);
  const { stale } = staleness(meta, staleHours);
  const errHtml = meta.last_error
    ? `<span class="err">${esc(meta.last_error)}</span>`
    : '<span class="ok">无</span>';
  const staleHtml = stale
    ? `<span class="err">数据已超过 ${staleHours} 小时未更新</span>`
    : '<span class="ok">正常</span>';

  const threshold = Math.max(1, Number(env.PROBE_FAIL_THRESHOLD ?? 2));
  const entries = Object.values(probe.entries);
  const alive = entries.filter((e) => e.ok).length;
  const dead = entries.filter((e) => !e.ok && e.fails >= threshold).length;
  const flaky = entries.filter((e) => !e.ok && e.fails < threshold).length;

  const sources = buildSources(env);
  const sourceRows = Object.entries(meta.source_stats)
    .map(([label, v]) => {
      const url = sources.find((s) => s.label === label)?.url ?? '';
      return `<div class="row"><span class="label">${esc(label)}</span><span class="url">${esc(url || '(未抓到)')}</span><span class="count">${v.kept}/${v.fetched}</span></div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MTV Source Converter · Cloudflare Workers</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1f2937;background:#fafafa}
h1{color:#2563eb;font-size:1.5rem;margin-bottom:.25rem}
.sub{color:#6b7280;font-size:.9rem;margin-top:0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h3{margin:.25rem 0 .75rem;font-size:1rem;color:#374151}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:.85em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f3f4f6}
.row:last-child{border-bottom:0}
.row .label{font-weight:600;width:120px;flex-shrink:0;font-size:.9rem}
.row .url{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:#2563eb;word-break:break-all}
.row .count{margin-left:auto;font-size:.75rem;color:#6b7280;flex-shrink:0}
.kv{display:grid;grid-template-columns:100px 1fr;gap:6px 12px;font-size:.9rem}
.kv b{color:#111827}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;background:#dbeafe;color:#1e40af;margin-left:6px}
.ok{color:#059669}.err{color:#dc2626;word-break:break-all}
ul{margin:.25rem 0;padding-left:1.25rem;font-size:.9rem}
li{margin:.3rem 0}
footer{color:#9ca3af;font-size:.75rem;text-align:center;margin:1.5rem 0}
</style>
</head>
<body>
<h1>🎬 MTV Source Converter <span class="badge">Cloudflare Workers</span></h1>
<p class="sub">边缘节点定时抓取 ziyuanzu.com，转换为 MoonTVPlus 配置。</p>

<div class="card">
<h3>📡 订阅地址</h3>
<div class="row"><span class="label">📦 全部站点</span><a class="url" href="/config.json">/config.json</a><span class="count">${meta.site_count} 个</span></div>
<div class="row"><span class="label">🛡️ 屏蔽成人版</span><a class="url" href="/config-safe.json">/config-safe.json</a><span class="count">${meta.safe_count} 个</span></div>
<div class="row"><span class="label">📄 TVBox 全部</span><a class="url" href="/config.txt">/config.txt</a><span class="count">${meta.site_count} 个</span></div>
<div class="row"><span class="label">📄 TVBox 屏蔽版</span><a class="url" href="/config-safe.txt">/config-safe.txt</a><span class="count">${meta.safe_count} 个</span></div>
</div>

<div class="card">
<h3>运行状态</h3>
<div class="kv">
<span>全部站点</span><b>${meta.site_count}</b>
<span>屏蔽版</span><b>${meta.safe_count}</b>
<span>探测剔除</span><b>${meta.filtered_count} 个死源</b>
<span>抓取成功</span><b>${meta.fetch_count} 次</b>
<span>抓取失败</span><b>${meta.error_count} 次</b>
<span>最后更新</span><b>${meta.last_updated ? esc(formatTime(meta.last_updated)) : '尚未抓取'}</b>
<span>数据新鲜度</span>${staleHtml}
<span>最近错误</span>${errHtml}
</div>
</div>

<div class="card">
<h3>🔌 数据源（去重后 / 抓到的）</h3>
${sourceRows || '<div class="row"><span class="label">—</span><span class="url">(尚未抓取)</span></div>'}
</div>

<div class="card">
<h3>🩺 源可用性</h3>
<div class="kv">
<span>已探测</span><b>${entries.length} 个</b>
<span>存活</span><b class="ok">${alive}</b>
<span>不稳</span><b>${flaky}（未达剔除阈值 ${threshold}）</b>
<span>判定死源</span><b class="err">${dead}</b>
<span>探测时间</span><b>${probe.updated_at ? esc(formatTime(probe.updated_at)) : '尚未探测'}</b>
</div>
</div>

<div class="card">
<h3>API 端点</h3>
<ul>
<li><a href="/config.json">GET /config.json</a> — 全部站点（Base58）</li>
<li><a href="/config-safe.json">GET /config-safe.json</a> — 屏蔽成人版（Base58）</li>
<li><a href="/config.txt">GET /config.txt</a> — TVBox TXT 全部</li>
<li><a href="/config-safe.txt">GET /config-safe.txt</a> — TVBox TXT 屏蔽版</li>
<li><a href="/health">GET /health</a> — 健康检查</li>
<li><a href="/stats">GET /stats</a> — 统计 + 源列表</li>
<li><a href="/sources">GET /sources</a> — 每个源的探测结果</li>
<li><code>POST /refresh</code> — 手动刷新（需 ADMIN_TOKEN）</li>
<li><code>POST /probe</code> — 手动探测一批源（需 ADMIN_TOKEN）</li>
</ul>
</div>

<footer>Cron 每天 01:00 / 13:00（北京时间）自动抓取 · 主源 ${esc(env.SOURCE_URL)}</footer>
</body>
</html>`;
}

function formatTime(iso: string): string {
  // 以 Asia/Shanghai 显示
  try {
    return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch {
    return iso;
  }
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    },
  });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });
}

/**
 * 订阅响应：Cron 每 2h 更新一次，客户端缓存 5 分钟既能挡住突发重复请求，
 * 又不会让订阅内容滞后太久。HEAD 请求由 Workers 运行时自动丢弃 body。
 */
function text(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}
