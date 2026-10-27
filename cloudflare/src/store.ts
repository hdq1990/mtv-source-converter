/**
 * KV 存储模块
 *
 * 使用 Cloudflare Workers KV 存储配置数据，
 * 替代 Python 版本中的内存存储（ConfigStore）。
 */

import {
  KV_KEY_FULL,
  KV_KEY_SAFE,
  KV_KEY_TVBOX_FULL,
  KV_KEY_TVBOX_SAFE,
  KV_KEY_META,
} from "./config";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Meta {
  site_count: number;
  safe_count: number;
  fetch_count: number;
  last_updated: string;
  last_error: string;
}

/**
 * 从 KV 存储读取配置
 */
export async function getConfigFull(kv: KVNamespace): Promise<Record<string, any>> {
  const raw = await kv.get(KV_KEY_FULL);
  return raw ? JSON.parse(raw) : { cache_time: 7200, api_site: {} };
}

export async function getConfigSafe(kv: KVNamespace): Promise<Record<string, any>> {
  const raw = await kv.get(KV_KEY_SAFE);
  return raw ? JSON.parse(raw) : { cache_time: 7200, api_site: {} };
}

export async function getTvboxFull(kv: KVNamespace): Promise<string> {
  return await kv.get(KV_KEY_TVBOX_FULL) || "";
}

export async function getTvboxSafe(kv: KVNamespace): Promise<string> {
  return await kv.get(KV_KEY_TVBOX_SAFE) || "";
}

export async function getMeta(kv: KVNamespace): Promise<Meta> {
  const raw = await kv.get(KV_KEY_META);
  if (raw) return JSON.parse(raw);
  return {
    site_count: 0,
    safe_count: 0,
    fetch_count: 0,
    last_updated: "",
    last_error: "",
  };
}

/**
 * 将配置写入 KV 存储
 */
export async function saveConfig(
  kv: KVNamespace,
  configFull: Record<string, any>,
  configSafe: Record<string, any>,
  tvboxFull: string,
  tvboxSafe: string,
): Promise<void> {
  await kv.put(KV_KEY_FULL, JSON.stringify(configFull));
  await kv.put(KV_KEY_SAFE, JSON.stringify(configSafe));
  await kv.put(KV_KEY_TVBOX_FULL, tvboxFull);
  await kv.put(KV_KEY_TVBOX_SAFE, tvboxSafe);

  const meta: Meta = {
    site_count: Object.keys(configFull.api_site || {}).length,
    safe_count: Object.keys(configSafe.api_site || {}).length,
    fetch_count: (await getMeta(kv)).fetch_count + 1,
    last_updated: new Date().toISOString().replace("T", " ").substring(0, 19),
    last_error: "",
  };
  await kv.put(KV_KEY_META, JSON.stringify(meta));
}

/**
 * 标记错误
 */
export async function markError(kv: KVNamespace, errorMsg: string): Promise<void> {
  const meta = await getMeta(kv);
  meta.last_error = errorMsg;
  await kv.put(KV_KEY_META, JSON.stringify(meta));
}
