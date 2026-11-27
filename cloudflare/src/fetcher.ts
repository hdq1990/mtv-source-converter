/**
 * 抓取模块：从 ziyuanzu.com 下载采集站清单（fetch API 版，带指数退避重试）
 */

import type { CmsSite } from './converter';

export interface FetchResult {
  ok: boolean;
  sites: CmsSite[];
  error?: string;
  attempts: number;
  elapsedMs: number;
}

export async function fetchSites(
  sourceUrl: string,
  timeoutMs: number,
  retries: number,
): Promise<FetchResult> {
  const started = Date.now();
  let lastError = '';

  for (let attempt = 1; attempt <= retries; attempt++) {
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
          cf: { cacheTtl: -1, cacheEverything: false },
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        lastError = `HTTP ${resp.status} ${resp.statusText}`;
        throw new Error(lastError);
      }

      const text = await resp.text();
      const data = JSON.parse(text) as unknown;
      if (!Array.isArray(data)) {
        throw new Error(`期望 JSON 数组，实际得到 ${Array.isArray(data) ? 'array' : typeof data}`);
      }
      const sites = data as CmsSite[];
      if (sites.length === 0) {
        throw new Error('上游返回空数组');
      }

      return { ok: true, sites, attempts: attempt, elapsedMs: Date.now() - started };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        // 指数退避：2s, 4s, 8s ...（与 Python 版 2**attempt 对齐）
        const wait = 2 ** attempt * 1000;
        await sleep(wait);
      }
    }
  }

  return { ok: false, sites: [], error: lastError, attempts: retries, elapsedMs: Date.now() - started };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
