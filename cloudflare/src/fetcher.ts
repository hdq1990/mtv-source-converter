/**
 * 抓取模块：上游清单 + 源可用性探测
 *
 * 上游支持三种格式，自动识别：
 *   1. 裸采集站数组      [{"name","api","apiType","uptime"}, ...]        ← ziyuanzu.com
 *   2. MoonTVPlus 配置   {"cache_time":7200,"api_site":{"k":{"api","name"}}}   ← 明文 JSON 订阅
 *   3. Base58 订阅串     上面第 2 种的 Base58 编码                          ← 各类 config.txt
 *
 * 重试策略与 Python 版对齐（2s → 4s → 8s 指数退避），但只重试「可能自愈」的错误：
 * 上游返回了合法内容但格式不对，退避再等 14 秒也变不出来，直接失败更省时间。
 */

import { base58Decode } from './base58';
import type { CmsSite } from './converter';

export interface FetchResult {
  ok: boolean;
  sites: CmsSite[];
  error?: string;
  attempts: number;
  elapsedMs: number;
}

/** 区分「值得重试」和「重试也没用」 */
class FatalFetchError extends Error {}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 看起来像 base58 订阅串（纯字母数字、没有 JSON 结构字符） */
function looksLikeBase58(text: string): boolean {
  if (text.length < 32) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
}

/** 把任意格式的响应体解析成采集站数组 */
export function parseSourceBody(text: string): CmsSite[] {
  const trimmed = text.trim();
  if (!trimmed) throw new FatalFetchError('响应为空');

  let data: unknown;
  let via: string;
  try {
    data = JSON.parse(trimmed);
    via = 'json';
  } catch {
    if (!looksLikeBase58(trimmed)) {
      throw new FatalFetchError(`响应不是合法 JSON（前 80 字符：${trimmed.slice(0, 80)}）`);
    }
    // Base58 订阅：解出来的还是 JSON
    try {
      const decoded = new TextDecoder().decode(base58Decode(trimmed));
      data = JSON.parse(decoded);
      via = 'base58';
    } catch (err) {
      throw new FatalFetchError(`Base58 解码失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 形态 1：裸数组
  if (Array.isArray(data)) {
    if (data.length === 0) throw new FatalFetchError('上游返回空数组');
    return data as CmsSite[];
  }

  // 形态 2：MoonTVPlus / LunaTV 配置对象
  if (data && typeof data === 'object') {
    const apiSite = (data as { api_site?: unknown }).api_site;
    if (apiSite && typeof apiSite === 'object') {
      const sites: CmsSite[] = Object.entries(apiSite as Record<string, unknown>).map(([key, raw]) => {
        const v = (raw ?? {}) as { api?: string; apiUrl?: string; name?: string };
        return { name: v.name ?? key, api: v.api ?? v.apiUrl ?? '' };
      }).filter((s) => typeof s.api === 'string' && s.api.length > 0);
      if (sites.length === 0) throw new FatalFetchError(`配置对象里没有可用的 api（via ${via}）`);
      return sites;
    }
    throw new FatalFetchError(`JSON 对象里找不到 api_site（via ${via}，顶层键：${Object.keys(data as object).slice(0, 5).join(',')}）`);
  }

  throw new FatalFetchError(`期望数组或配置对象，实际得到 ${typeof data}`);
}

export async function fetchSites(
  sourceUrl: string,
  timeoutMs: number,
  retries: number,
): Promise<FetchResult> {
  const started = Date.now();
  const maxAttempts = Math.max(1, retries);
  let lastError = '';
  let attempts = 0;

  const describe = (err: unknown): string => {
    if (err instanceof Error) {
      if (err.name === 'AbortError') return `请求超时（>${timeoutMs} ms）`;
      // Workers 会把底层网络错误统一包装成 "internal error; reference = xxx"，
      // 直接透出这句对排障没有帮助，这里补一层人话
      if (/internal error/i.test(err.message)) {
        return `上游不可达（DNS/TLS/连接失败）: ${err.message}`;
      }
      return err.message;
    }
    return String(err);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(sourceUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
          // 绕过 Cloudflare 的响应缓存，回源拿最新清单
          cf: { cacheTtl: -1, cacheEverything: false },
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        // 4xx 基本是配置或上游路由问题，重试意义不大；5xx 和限流才重试
        const retryable = resp.status >= 500 || resp.status === 429;
        if (resp.body) await resp.body.cancel().catch(() => {});
        const msg = `HTTP ${resp.status} ${resp.statusText}`;
        if (!retryable) throw new FatalFetchError(msg);
        lastError = msg;
        throw new Error(msg);
      }

      const sites = parseSourceBody(await resp.text());
      return { ok: true, sites, attempts: attempt, elapsedMs: Date.now() - started };
    } catch (err) {
      lastError = describe(err);
      if (err instanceof FatalFetchError) break;
      if (attempt < maxAttempts) {
        // 指数退避：2s, 4s, 8s ...（与 Python 版 2**attempt 对齐）
        await sleep(2 ** attempt * 1000);
      }
    }
  }

  return { ok: false, sites: [], error: lastError, attempts, elapsedMs: Date.now() - started };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 源可用性探测
// ---------------------------------------------------------------------------

export type ProbeCode = 'ok' | 'http' | 'timeout' | 'network' | 'bad_body' | 'skipped';

export interface ProbeOutcome {
  ok: boolean;
  code: ProbeCode;
  detail: string;
  ms: number;
  /** 证据强度：hard = 源本身有问题，soft = 可能只是探测端网络问题 */
  weight: 'hard' | 'soft';
}

/**
 * 探测一个采集站 API 是否可用。
 *
 * 地址拼接规则：只有 api 本身不带 query 时才追加 `?ac=detail&pg=1`。
 * 带 query 的多半是「代理型」地址（如 `https://proxy/?url=https://x/api.php`），
 * 再拼一个 `&ac=...` 会被代理当作目标 URL 的一部分，直接 404。
 *
 * 判据放宽到「2xx 且 body 里能看出 JSON 结构」，因为有的源返回 `{"data":...}`、
 * 有的 `{"code":1,...}`，只看 JSON.parse 会把活源误杀。
 */
export async function probeApi(api: string, timeoutMs: number): Promise<ProbeOutcome> {
  const started = Date.now();
  const url = api.includes('?') ? api : `${api.replace(/\/+$/, '')}?ac=detail&pg=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      cf: { cacheTtl: -1, cacheEverything: false },
    } as RequestInit);

    const ms = Date.now() - started;
    if (!resp.ok) {
      if (resp.body) await resp.body.cancel().catch(() => {});
      // 4xx 说明路径/权限真的不对，算硬证据；5xx 可能只是临时故障
      const hard = resp.status >= 400 && resp.status < 500;
      return { ok: false, code: 'http', detail: `HTTP ${resp.status}`, ms, weight: hard ? 'hard' : 'soft' };
    }

    const text = (await resp.text()).slice(0, 4096);
    const head = text.trim();
    const looksJson = head.startsWith('{') || head.startsWith('[');
    const hasList = head.includes('"list"') || head.includes('"data"') || head.includes('"code"');
    if (looksJson && hasList) return { ok: true, code: 'ok', detail: 'json', ms, weight: 'soft' };

    // 返回 RSS/XML：接口类型不对，MoonTVPlus 的 type=0 只吃苹果 CMS JSON → 硬证据
    const isXml = head.startsWith('<?xml') || head.startsWith('<rss') || head.includes('<rss');
    // 返回 HTML：多半是错误页/跳转页，可能是临时问题 → 软证据
    const isHtml = head.startsWith('<!DOCTYPE') || head.startsWith('<html') || head.includes('<html');

    return {
      ok: false,
      code: 'bad_body',
      detail: (isXml ? 'RSS/XML（接口类型不兼容）' : isHtml ? 'HTML（疑似错误页）' : head.slice(0, 60)) || '(空响应)',
      ms,
      weight: isXml ? 'hard' : 'soft',
    };
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, code: 'timeout', detail: `>${timeoutMs}ms`, ms, weight: 'soft' };
    }
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      ms,
      weight: 'soft',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按 concurrency 分批探测（Workers 每个 invocation 最多 6 个并发连接，
 * 这里默认 5 留一点余量给 KV 和上游）。
 */
export async function probeMany(
  apis: { key: string; api: string }[],
  timeoutMs: number,
  concurrency = 5,
): Promise<Record<string, ProbeOutcome>> {
  const out: Record<string, ProbeOutcome> = {};
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, apis.length) }, async () => {
    while (i < apis.length) {
      const idx = i++;
      const item = apis[idx];
      out[item.key] = await probeApi(item.api, timeoutMs);
    }
  });
  await Promise.all(workers);
  return out;
}