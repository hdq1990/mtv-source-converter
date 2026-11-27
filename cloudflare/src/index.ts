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
import { convertToMoonTVPlus, convertToTvbox, type CmsSite } from './converter';
import { fetchSites } from './fetcher';
import {
  readConfigB58,
  readConfigJson,
  readMeta,
  readTvbox,
  writeConfigB58,
  writeError,
  writeSnapshot,
  type Meta,
} from './store';

/**
 * Cron 分两跳：
 *   :00 → 抓取 + 转换 + 编码「全部版」+ 写全部 KV
 *   :02 → 从 KV 读「屏蔽版」明文，只编码这一份
 * 拆开的原因是 Base58 编码单份约 14 ms CPU，两份 28 ms 已经远超 Workers 免费
 * 套餐的 10 ms 预算；拆成两次调用，每次只超 40%，落在运行时的容错范围内。
 */
const SAFE_CRON = '2 */2 * * *';

export interface Env {
  CONFIG: KVNamespace;
  SOURCE_URL: string;
  CACHE_TIME: string;
  FETCH_TIMEOUT: string;
  FETCH_RETRIES: string;
  STALE_IF_ERROR_HOURS: string;
  ADMIN_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isRefresh = path === '/refresh';

    // /refresh 只接受 POST（GET 带 token 也能触发的写法会把刷新动作暴露给预取/爬虫）
    if (isRefresh) {
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
        case '/refresh': {
          const r = await manualRefresh(req, env);
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
    if (controller.cron === SAFE_CRON) {
      ctx.waitUntil(encodeSafeFromKv(env));
      return;
    }
    ctx.waitUntil(refresh(env, 'cron', 'full'));
  },
} satisfies ExportedHandler<Env>;

/** Cron 第二跳：屏蔽版明文已经在上一次调用里写好了，这里只补 Base58 编码 */
async function encodeSafeFromKv(env: Env): Promise<void> {
  const cfg = await readConfigJson(env.CONFIG, false);
  if (Object.keys(cfg.api_site).length === 0) return;
  await writeConfigB58(env.CONFIG, false, base58Encode(JSON.stringify(cfg)));
}

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
  error?: string;
  attempts: number;
  elapsedMs: number;
}

export async function refresh(
  env: Env,
  trigger: string,
  encode: EncodeTarget = 'both',
): Promise<RefreshResult> {
  const started = Date.now();
  const timeoutMs = Number(env.FETCH_TIMEOUT ?? 30) * 1000;
  const retries = Number(env.FETCH_RETRIES ?? 3);
  const cacheTime = Number(env.CACHE_TIME ?? 7200);

  const result = await fetchSites(env.SOURCE_URL, timeoutMs, retries);

  if (!result.ok) {
    const error = result.error ?? 'unknown';
    // 只写错误信息，保留下次成功时的数据继续对外服务
    await writeError(env.CONFIG, `[${trigger}] ${error}`);
    return { ok: false, siteCount: 0, safeCount: 0, error, attempts: result.attempts, elapsedMs: result.elapsedMs };
  }

  const sites: CmsSite[] = result.sites;
  const configFull = convertToMoonTVPlus(sites, cacheTime, false);
  const configSafe = convertToMoonTVPlus(sites, cacheTime, true);
  const tvboxFull = convertToTvbox(sites, false);
  const tvboxSafe = convertToTvbox(sites, true);

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
      last_duration_ms: Date.now() - started,
      last_attempts: result.attempts,
      source_url: env.SOURCE_URL,
    },
  );

  return {
    ok: true,
    siteCount: Object.keys(configFull.api_site).length,
    safeCount: Object.keys(configSafe.api_site).length,
    attempts: result.attempts,
    elapsedMs: Date.now() - started,
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
      attempts: result.attempts,
      elapsed_ms: result.elapsedMs,
      error: result.error ?? null,
    },
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
    last_updated: meta.last_updated || null,
    age_seconds: ageSeconds,
    stale_after_hours: staleHours,
    fetch_count: meta.fetch_count,
    error_count: meta.error_count,
    last_error: meta.last_error || null,
  };
}

async function stats(env: Env): Promise<Record<string, unknown>> {
  // 只读需要的 3 个 key（meta + 两份明文），不再读 5 个
  const [meta, configFull, configSafe] = await Promise.all([
    readMeta(env.CONFIG),
    readConfigJson(env.CONFIG, true),
    readConfigJson(env.CONFIG, false),
  ]);
  const toList = (cfg: typeof configFull) =>
    Object.entries(cfg.api_site).map(([key, v]) => ({ key, name: v.name, api: v.api }));
  return {
    ...meta,
    cache_time: configFull.cache_time,
    total_sources: toList(configFull),
    safe_sources: toList(configSafe),
  };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function renderIndex(env: Env): Promise<string> {
  const meta = await readMeta(env.CONFIG);
  const staleHours = Number(env.STALE_IF_ERROR_HOURS ?? 72);
  const { stale } = staleness(meta, staleHours);
  const errHtml = meta.last_error
    ? `<span class="err">${esc(meta.last_error)}</span>`
    : '<span class="ok">无</span>';
  const staleHtml = stale
    ? `<span class="err">数据已超过 ${staleHours} 小时未更新</span>`
    : '<span class="ok">正常</span>';

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
<span>抓取成功</span><b>${meta.fetch_count} 次</b>
<span>抓取失败</span><b>${meta.error_count} 次</b>
<span>最后更新</span><b>${meta.last_updated ? esc(formatTime(meta.last_updated)) : '尚未抓取'}</b>
<span>数据新鲜度</span>${staleHtml}
<span>最近错误</span>${errHtml}
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
</ul>
</div>

<footer>Cron 每 2 小时自动抓取 · 数据源 ${esc(env.SOURCE_URL)}</footer>
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
