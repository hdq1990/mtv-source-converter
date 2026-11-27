/**
 * 抓取模块：从 ziyuanzu.com 下载采集站清单（fetch API 版）
 *
 * 重试策略与 Python 版对齐（2s → 4s → 8s 指数退避），但有一个区别：
 * 只有「可能自愈」的错误才重试。上游返回了合法 JSON 但不是数组 / 是空数组，
 * 说明接口本身变了或数据源异常，退避再等 14 秒也变不出来，直接失败更省时间，
 * 也让 Cron 更快落到 writeError（保留旧数据继续服务）。
 */

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
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

      const text = await resp.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new FatalFetchError(`响应不是合法 JSON（前 80 字符：${text.slice(0, 80)}）`);
      }
      if (!Array.isArray(data)) {
        throw new FatalFetchError(`期望 JSON 数组，实际得到 ${typeof data}`);
      }
      const sites = data as CmsSite[];
      if (sites.length === 0) {
        throw new FatalFetchError('上游返回空数组');
      }

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
