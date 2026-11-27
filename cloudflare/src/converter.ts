/**
 * 转换模块：采集站清单 -> MoonTVPlus api_site / TVBox TXT
 * 逻辑与 Python 版 converter.py 完全对齐。
 */

export interface CmsSite {
  name: string;
  api?: string;
  apiUrl?: string;
  apiType?: string;
  uptime?: string | number;
  [k: string]: unknown;
}

export interface ApiSiteEntry {
  api: string;
  name: string;
}

export interface MoonTVConfig {
  cache_time: number;
  api_site: Record<string, ApiSiteEntry>;
}

// 成人站过滤关键词（按名称匹配）
export const ADULT_NAME_KEYWORDS = [
  '湿乐园', '番号', '麻豆', '色仓库', '黑料', '搜A-V',
  '白嫖', '美少女', '色A-V', '清水源', '香系源', '老色X',
  '色猫', '精品X', '大X子',
];

// 成人站过滤关键词（按域名匹配）
export const ADULT_DOMAIN_KEYWORDS = [
  'xxavs', 'fhapi', '91md', 'hsckzy', 'heiliaozy', 'souav',
  'kxgav', 'msnii', 'pgxdy', 'xrbsp', 'gdlsp', 'apilsbzy',
  'semaozy', 'jingpinx', 'apidanaizi',
];

function hostOf(api: string): string {
  try {
    return new URL(api).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 从站点 API 域名生成唯一的小写字母/数字 key（与 Python make_key 等价） */
export function makeKey(site: CmsSite, usedKeys: Set<string>): string {
  const api = site.api || site.apiUrl || '';
  const domain = hostOf(api).replace(/^www\./, '');
  const firstPart = domain ? domain.split('.')[0] : 'site';
  let key = firstPart.replace(/[^a-z0-9]/g, '') || 'site';
  const base = key;
  let n = 1;
  while (usedKeys.has(key)) {
    n += 1;
    key = `${base}${n}`;
  }
  return key;
}

export function isAdultSite(site: CmsSite): boolean {
  const name = site.name || '';
  const domain = hostOf(site.api || site.apiUrl || '');
  return ADULT_NAME_KEYWORDS.some((kw) => name.includes(kw))
    || ADULT_DOMAIN_KEYWORDS.some((kw) => domain.includes(kw));
}

export function convertToMoonTVPlus(sites: CmsSite[], cacheTime: number, filterAdult: boolean): MoonTVConfig {
  const apiSite: Record<string, ApiSiteEntry> = {};
  const usedKeys = new Set<string>();

  for (const site of sites) {
    if (filterAdult && isAdultSite(site)) continue;

    const key = makeKey(site, usedKeys);
    usedKeys.add(key);

    apiSite[key] = {
      api: site.api || site.apiUrl || '',
      name: site.name || '',
    };
  }

  return { cache_time: cacheTime, api_site: apiSite };
}

export function convertToTvbox(sites: CmsSite[], filterAdult: boolean): string {
  const lines: string[] = [];
  for (const site of sites) {
    if (filterAdult && isAdultSite(site)) continue;
    const api = site.api || site.apiUrl || '';
    const name = site.name || '';
    const uptime = site.uptime == null ? '' : String(site.uptime);
    const apiType = site.apiType || 'json';
    lines.push(`${name}|${api}|${apiType}|${uptime}`);
  }
  return lines.join('\n');
}
