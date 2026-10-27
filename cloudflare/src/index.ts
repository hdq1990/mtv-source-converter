/**
 * MTV Source Converter - Cloudflare Workers
 *
 * 定时从 ziyuanzu.com 抓取采集站清单，转换为 MoonTVPlus 配置，
 * 通过 HTTP 提供订阅地址（双版本：全部 + 屏蔽成人版）。
 *
 * 部署：wrangler deploy
 * 测试：wrangler dev
 */

import { fetchWithRetry } from "./fetcher";
import { convertToMoontvplus, convertToTvbox } from "./converter";
import {
  getConfigFull, getConfigSafe, getTvboxFull, getTvboxSafe,
  getMeta, saveConfig, markError,
} from "./store";
import { CACHE_TIME } from "./config";

export interface Env {
  KV: KVNamespace;
}

/**
 * 定时抓取 + 转换 + 保存到 KV
 */
async function doFetchAndConvert(env: Env): Promise<boolean> {
  console.log(`[${new Date().toISOString()}] 开始抓取`);
  const { sites, error } = await fetchWithRetry();

  if (error || !sites) {
    markError(env.KV, String(error));
    console.log(`❌ 抓取失败: ${error}`);
    return false;
  }

  // 生成两个版本：不屏蔽（全部）和屏蔽成人
  const configFull = convertToMoontvplus(sites, false, CACHE_TIME);
  const configSafe = convertToMoontvplus(sites, true, CACHE_TIME);
  const tvboxFull = convertToTvbox(sites, false);
  const tvboxSafe = convertToTvbox(sites, true);

  await saveConfig(env.KV, configFull, configSafe, tvboxFull, tvboxSafe);

  const meta = await getMeta(env.KV);
  console.log(`✅ 抓取成功: ${meta.site_count} 个采集站（全部）`);
  console.log(`  屏蔽版: ${meta.safe_count} 个采集站`);
  return true;
}

/**
 * Fetch handler — 处理 HTTP 请求
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    // GET / — 服务信息页
    if (path === "/" && request.method === "GET") {
      return handleIndex(env);
    }

    // GET /config.json — 全部站点订阅
    if (path === "/config.json" && request.method === "GET") {
      const config = await getConfigFull(env.KV);
      return jsonResponse(config);
    }

    // GET /config-safe.json — 屏蔽成人版订阅
    if (path === "/config-safe.json" && request.method === "GET") {
      const config = await getConfigSafe(env.KV);
      return jsonResponse(config);
    }

    // GET /config.txt — TVBox 全部
    if (path === "/config.txt" && request.method === "GET") {
      const text = await getTvboxFull(env.KV);
      if (!text) return jsonResponse({ error: "config not ready" }, 503);
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // GET /config-safe.txt — TVBox 屏蔽版
    if (path === "/config-safe.txt" && request.method === "GET") {
      const text = await getTvboxSafe(env.KV);
      if (!text) return jsonResponse({ error: "config not ready" }, 503);
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // GET /health — 健康检查
    if (path === "/health" && request.method === "GET") {
      const meta = await getMeta(env.KV);
      const status = meta.site_count > 0 ? "ok" : "starting";
      return jsonResponse({ status, sites: meta.site_count });
    }

    // GET /stats — 统计信息
    if (path === "/stats" && request.method === "GET") {
      const meta = await getMeta(env.KV);
      const configFull = await getConfigFull(env.KV);
      const configSafe = await getConfigSafe(env.KV);
      return jsonResponse({
        ...meta,
        cache_time: configFull.cache_time,
        total_sources: Object.entries(configFull.api_site || {}).map(([k, v]) => ({
          key: k, name: v.name, api: v.api,
        })),
        safe_sources: Object.entries(configSafe.api_site || {}).map(([k, v]) => ({
          key: k, name: v.name, api: v.api,
        })),
      });
    }

    // POST /fetch — 手动触发抓取
    if (path === "/fetch" && request.method === "POST") {
      await doFetchAndConvert(env);
      return jsonResponse({ status: "ok", message: "抓取已触发" });
    }

    return jsonResponse({ error: "not found", path }, 404);
  },

  /**
   * Scheduled handler — 定时抓取
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await doFetchAndConvert(env);
    } catch (e) {
      console.error(`⚠️ 抓取异常: ${e}`);
      await markError(env.KV, String(e));
    }
  },
};

/**
 * 服务信息页（HTML）
 */
async function handleIndex(env: Env): Promise<Response> {
  const meta = await getMeta(env.KV);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MTV Source Converter - Cloudflare Workers</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#333}
h1{color:#2563eb}.card{border:1px solid #e0e0e0;border-radius:8px;padding:1rem;margin:1rem 0}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:.9em}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.sub{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eee}
.sub-label{font-weight:bold;width:120px;flex-shrink:0}
.sub-url{font-family:monospace;font-size:.85em;color:#2563eb}
.sub-count{margin-left:auto;font-size:.8em;color:#666}
</style>
</head>
<body>
<h1>🎬 MTV Source Converter</h1>
<p>Cloudflare Workers 版本 — 定时从 ziyuanzu.com 抓取采集站清单。</p>
<div class="card">
<h3>📡 订阅地址（两个版本）</h3>
<div class="sub">
<span class="sub-label">📦 全部站点</span>
<a href="/config.json"><code>https://&lt;your-worker&gt;.workers.dev/config.json</code></a>
<span class="sub-count">${meta.site_count} 个站点</span>
</div>
<div class="sub">
<span class="sub-label">🛡️ 屏蔽成人版</span>
<a href="/config-safe.json"><code>https://&lt;your-worker&gt;.workers.dev/config-safe.json</code></a>
<span class="sub-count">${meta.safe_count} 个站点</span>
</div>
<div class="sub">
<span class="sub-label">📄 TVBox 全部</span>
<a href="/config.txt"><code>https://&lt;your-worker&gt;.workers.dev/config.txt</code></a>
</div>
<div class="sub">
<span class="sub-label">📄 TVBox 屏蔽版</span>
<a href="/config-safe.txt"><code>https://&lt;your-worker&gt;.workers.dev/config-safe.txt</code></a>
</div>
</div>
<div class="card">
<h3>运行状态</h3>
<p>全部站点: <b>${meta.site_count}</b> · 屏蔽版: <b>${meta.safe_count}</b></p>
<p>抓取次数: <b>${meta.fetch_count}</b></p>
<p>最后更新: <b>${meta.last_updated || '尚未抓取'}</b></p>
<p>最近错误: ${meta.last_error ? '<span style="color:#991b1b">' + meta.last_error + '</span>' : '<span style="color:#065f46">无</span>'}</p>
</div>
<div class="card">
<h3>API 端点</h3>
<ul>
<li><a href="/config.json">GET /config.json</a> - 全部站点配置</li>
<li><a href="/config-safe.json">GET /config-safe.json</a> - 屏蔽成人版配置</li>
<li><a href="/config.txt">GET /config.txt</a> - TVBox 全部格式</li>
<li><a href="/config-safe.txt">GET /config-safe.txt</a> - TVBox 屏蔽版格式</li>
<li><a href="/health">GET /health</a> - 健康检查</li>
<li><a href="/stats">GET /stats</a> - 统计信息</li>
<li>POST /fetch - 手动触发抓取</li>
</ul>
</div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * JSON 响应
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    },
    status,
  });
}
