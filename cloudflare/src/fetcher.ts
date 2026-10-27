/**
 * 抓取模块：从 ziyuanzu.com 下载采集站清单
 *
 * 使用 Cloudflare Workers 原生 fetch API
 */

import { SOURCE_URL } from "./config";

interface Site {
  name: string;
  api: string;
  apiType?: string;
  uptime?: string;
  speed?: string;
  totalResources?: number;
  categories?: string[];
}

/**
 * 从 ziyuanzu.com 下载采集站 JSON 清单
 */
export async function fetchSites(url: string = SOURCE_URL): Promise<Site[]> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  const text = await resp.text();
  const data = JSON.parse(text);

  if (!Array.isArray(data)) {
    throw new Error(`期望 JSON 数组，实际得到 ${typeof data}`);
  }

  return data as Site[];
}

/**
 * 带重试的抓取，失败时等待指数退避后重试
 */
export async function fetchWithRetry(
  url: string = SOURCE_URL,
  retries: number = 3,
): Promise<{ sites: Site[] | null; error: Error | null }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const sites = await fetchSites(url);
      return { sites, error: null };
    } catch (e) {
      lastError = e as Error;
      if (attempt < retries) {
        const wait = 2 ** attempt;
        console.log(`  抓取失败（第 ${attempt} 次），${wait}s 后重试... 错误: ${e}`);
        // Cloudflare Workers 中不能 sleep，用 await new Promise 替代
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        console.log(`  抓取失败（第 ${attempt} 次），放弃: ${e}`);
      }
    }
  }
  return { sites: null, error: lastError };
}
