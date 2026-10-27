/**
 * 转换模块：将采集站清单转换为 MoonTVPlus api_site 配置
 *
 * MoonTVPlus 的 api_site 仅支持 type=0（苹果 CMS V10），
 * ziyuanzu.com 的采集站全部是苹果 CMS V10 的 /api.php/provide/vod/ json 接口，
 * 因此可以直接转换使用。
 */

import { CACHE_TIME } from "./config";

interface Site {
  name: string;
  api: string;
  apiType?: string;
  uptime?: string;
  speed?: string;
  totalResources?: number;
  categories?: string[];
}

// 成人站过滤关键词（按名称匹配）
const ADULT_NAME_KEYWORDS = [
  "湿乐园", "番号", "麻豆", "色仓库", "黑料", "搜A-V",
  "白嫖", "美少女", "色A-V", "清水源", "香系源", "老色X",
  "色猫", "精品X", "大X子",
];

// 成人站过滤关键词（按域名匹配）
const ADULT_DOMAIN_KEYWORDS = [
  "xxavs", "fhapi", "91md", "hsckzy", "heiliaozy", "souav",
  "kxgav", "msnii", "pgxdy", "xrbsp", "gdlsp", "apilsbzy",
  "semaozy", "jingpinx", "apidanaizi",
];

/**
 * 判断是否为成人站
 */
function shouldFilterAdult(site: Site): boolean {
  const name = site.name || "";
  const api = site.api || "";

  for (const kw of ADULT_NAME_KEYWORDS) {
    if (name.includes(kw)) return true;
  }
  for (const kw of ADULT_DOMAIN_KEYWORDS) {
    if (api.includes(kw)) return true;
  }
  return false;
}

/**
 * 从站点 API 域名生成唯一的小写字母/数字 key
 */
function makeKey(site: Site, usedKeys: Set<string>): string {
  const api = site.api || "";
  let domain = "";
  try {
    domain = new URL(api).hostname.toLowerCase();
  } catch {
    domain = "";
  }
  domain = domain.replace("www.", "");

  // 取第一个子域片段作为 key 基础
  const firstPart = domain.split(".")[0] || "site";
  let key = firstPart.replace(/[^a-z0-9]/g, "");
  if (!key) key = "site";

  // 去重：若已存在则加数字后缀
  let base = key;
  let n = 1;
  while (usedKeys.has(key)) {
    n++;
    key = `${base}${n}`;
  }
  return key;
}

/**
 * 将采集站清单转换为 MoonTVPlus 配置文件格式
 */
export function convertToMoontvplus(
  sites: Site[],
  filterAdult: boolean = false,
  cacheTime: number = CACHE_TIME,
): { cache_time: number; api_site: Record<string, { api: string; name: string }> } {
  const apiSite: Record<string, { api: string; name: string }> = {};
  const usedKeys = new Set<string>();

  for (const site of sites) {
    if (filterAdult && shouldFilterAdult(site)) continue;

    const key = makeKey(site, usedKeys);
    usedKeys.add(key);

    apiSite[key] = {
      api: site.api,
      name: site.name,
    };
  }

  return { cache_time: cacheTime, api_site: apiSite };
}

/**
 * 将采集站清单转换为 TVBox 风格的 TXT 格式
 */
export function convertToTvbox(sites: Site[], filterAdult: boolean = false): string {
  const lines: string[] = [];
  for (const site of sites) {
    if (filterAdult && shouldFilterAdult(site)) continue;
    const uptime = site.uptime || "";
    const apiType = site.apiType || "json";
    lines.push(`${site.name}|${site.api}|${apiType}|${uptime}`);
  }
  return lines.join("\n");
}
