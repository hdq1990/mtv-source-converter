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

/** 对外暴露：合并去重、探测、统计都要按域名识别同一个站 */
export function siteDomain(site: { api?: string; apiUrl?: string }): string {
  return hostOf(site.api || site.apiUrl || '').replace(/^www\./, '');
}

/** 带来源标签的站点（合并后每个站知道自己从哪个上游来的） */
export interface SourcedSite extends CmsSite {
  source: string;
  domain: string;
}

export interface SourceGroup {
  /** 来源标签，写进 /stats 方便看每个源贡献了多少站 */
  label: string;
  sites: CmsSite[];
}

/**
 * 多源合并：按 API 域名去重，先出现的赢（主源优先级最高，extras 按配置顺序）。
 *
 * 去重必须按域名而不是 URL：同一个采集站经常同时提供
 * `https://x.com/api.php/provide/vod` 和 `.../vod/`（尾斜杠差异），
 * 也有 http/https 混用的，直接比字符串会把同一个站算成两个。
 */
export function mergeSites(groups: SourceGroup[]): SourcedSite[] {
  const seen = new Set<string>();
  const out: SourcedSite[] = [];

  for (const group of groups) {
    for (const site of group.sites) {
      const api = site.api || site.apiUrl || '';
      if (!/^https?:\/\//i.test(api)) continue; // 丢掉没有 API 地址的脏数据

      const domain = siteDomain(site);
      if (!domain) continue;
      if (seen.has(domain)) continue;

      seen.add(domain);
      out.push({ ...site, api, source: group.label, domain });
    }
  }

  return out;
}

/** 每个源贡献了多少站、有多少被去重掉 */
export function sourceSummary(groups: SourceGroup[], merged: SourcedSite[]): Record<string, { fetched: number; kept: number }> {
  const count: Record<string, number> = {};
  for (const s of merged) count[s.source] = (count[s.source] ?? 0) + 1;
  const out: Record<string, { fetched: number; kept: number }> = {};
  for (const g of groups) {
    out[g.label] = { fetched: g.sites.length, kept: count[g.label] ?? 0 };
  }
  return out;
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
