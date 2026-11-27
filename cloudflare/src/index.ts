/**
 * MTV Source Converter — Cloudflare Workers 入口
 *
 * 架构：
 *   Cron Trigger（每 2h）  →  fetch ziyuanzu.com  →  转换  →  写 KV
 *   fetch handler          →  读 KV 直接返回（零上游依赖）
 *   兜底                    →  KV 为空时在请求内实时抓取一次并回写
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
import { readMeta, readSnapshot, writeError, writeSnapshot } from './store';

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

    if (req.method !== 'GET' && req.method !== 'HEAD' && !(isRefresh && req.method === 'POST')) {
      return json({ error: 'method not allowed' }, 405);
    }

    try {
      switch (path) {
        case '/':
          return html(await renderIndex(env));
        case '/config.json':
          return text(base58Encode(JSON.stringify(await loadConfig(env, true))));
        case '/config-safe.json':
          return text(base58Encode(JSON.stringify(await loadConfig(env, false))));
        case '/config.txt':
          return text(await loadTvbox(env, true));
        case '/config-safe.txt':
          return text(await loadTvbox(env, false));
        case '/health':
          return json(await health(env));
        case '/stats':
          return json(await stats(env));
        case '/refresh': {
          const r = await manualRefresh(req, env);
          return json(r.body, r.status);
        }
        default:
          return json({ error: 'not found', path: url.pathname }, 404);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: 'internal error', detail: msg }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refresh(env, 'cron'));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// 配置读取（带冷启动兜底）
// ---------------------------------------------------------------------------

async function loadConfig(env: Env, full: boolean) {
  const snap = await readSnapshot(env.CONFIG);
  const cfg = full ? snap.configFull : snap.configSafe;
  if (Object.keys(cfg.api_site).length > 0) return cfg;

  // KV 为空：实时抓取一次
  const result = await refresh(env, 'cold-start');
  if (result.ok) {
    const after = await readSnapshot(env.CONFIG);
    return full ? after.configFull : after.configSafe;
  }
  return cfg;
}

async function loadTvbox(env: Env, full: boolean) {
  const snap = await readSnapshot(env.CONFIG);
  const value = full ? snap.tvboxFull : snap.tvboxSafe;
  if (value) return value;

  const result = await refresh(env, 'cold-start');
  if (result.ok) {
    const after = await readSnapshot(env.CONFIG);
    return full ? after.tvboxFull : after.tvboxSafe;
  }
  return value || '（尚未抓取，请稍后重试）';
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

export async function refresh(env: Env, trigger: string): Promise<RefreshResult> {
  const started = Date.now();
  const timeoutMs = Number(env.FETCH_TIMEOUT ?? 30) * 1000;
  const retries = Number(env.FETCH_RETRIES ?? 3);
  const cacheTime = Number(env.CACHE_TIME ?? 7200);

  const result = await fetchSites(env.SOURCE_URL, timeoutMs, retries);

  if (!result.ok) {
    const error = result.error ?? 'unknown';
    await writeError(env.CONFIG, `[${trigger}] ${error}`);
    return { ok: false, siteCount: 0, safeCount: 0, error, attempts: result.attempts, elapsedMs: result.elapsedMs };
  }

  const sites: CmsSite[] = result.sites;
  const configFull = convertToMoonTVPlus(sites, cacheTime, false);
  const configSafe = convertToMoonTVPlus(sites, cacheTime, true);
  const tvboxFull = convertToTvbox(sites, false);
  const tvboxSafe = convertToTvbox(sites, true);

  await writeSnapshot(env.CONFIG, { configFull, configSafe, tvboxFull, tvboxSafe }, {
    site_count: Object.keys(configFull.api_site).length,
    safe_count: Object.keys(configSafe.api_site).length,
    last_duration_ms: Date.now() - started,
    last_attempts: result.attempts,
    source_url: env.SOURCE_URL,
  });

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

// 手动刷新：POST，需要 ADMIN_TOKEN（query ?token= 或 X-Admin-Token 头）
async function manualRefresh(req: Request, env: Env): Promise<{ body: Record<string, unknown>; status: number }> {
  const url = new URL(req.url);
  const given = url.searchParams.get('token') || req.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN) {
    return { body: { error: 'ADMIN_TOKEN 未配置，手动刷新已禁用（Cron 仍正常运行）' }, status: 403 };
  }
  if (given !== env.ADMIN_TOKEN) {
    return { body: { error: 'invalid admin token' }, status: 401 };
  }

  const result = await refresh(env, 'manual');
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

async function health(env: Env): Promise<Record<string, unknown>> {
  const meta = await readMeta(env.CONFIG);
  return {
    status: meta.site_count > 0 ? 'ok' : 'starting',
    sites: meta.site_count,
    safe_sites: meta.safe_count,
    last_updated: meta.last_updated || null,
    last_error: meta.last_error || null,
  };
}

async function stats(env: Env): Promise<Record<string, unknown>> {
  const snap = await readSnapshot(env.CONFIG);
  const toList = (cfg: typeof snap.configFull) =>
    Object.entries(cfg.api_site).map(([key, v]) => ({ key, name: v.name, api: v.api }));
  return {
    ...snap.meta,
    cache_time: snap.configFull.cache_time,
    total_sources: toList(snap.configFull),
    safe_sources: toList(snap.configSafe),
  };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function renderIndex(env: Env): Promise<string> {
  const meta = await readMeta(env.CONFIG);
  const errHtml = meta.last_error
    ? `<span class="err">${esc(meta.last_error)}</span>`
    : '<span class="ok">无</span>';

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
<span>抓取次数</span><b>${meta.fetch_count}</b>
<span>最后更新</span><b>${meta.last_updated ? esc(formatTime(meta.last_updated)) : '尚未抓取'}</b>
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}

