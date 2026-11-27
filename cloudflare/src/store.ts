/**
 * KV 存储层
 *
 * key 约定（共 7 个）：
 *   config_full      全部站点 MoonTVPlus JSON（明文，供 /stats 与调试）
 *   config_safe      屏蔽成人版 MoonTVPlus JSON
 *   config_full_b58  全部站点的 Base58 编码结果（订阅接口直接返回，省掉每请求编码）
 *   config_safe_b58  屏蔽版的 Base58 编码结果
 *   tvbox_full       TVBox TXT 全部
 *   tvbox_safe       TVBox TXT 屏蔽版
 *   meta             元数据
 *
 * 为什么要把 Base58 结果也存下来：见 base58.ts 顶部注释。编码一次的 CPU 成本
 * 是 20+ ms，编码两份 40+ ms，免费套餐每次调用只有 10 ms 预算；放在 Cron 里算
 * 一次、请求路径只读字符串，订阅接口的 CPU 才降到 1 ms 以下。
 *
 * ⚠ 读取一律按需单 key：KV 每次 get 都是一次 subrequest，免费套餐限制 50 次/请求。
 * 原来的 readSnapshot() 在一个请求里读全部 5 个 key，等于每访问一次 /config.json
 * 就产生 5 次读，免费额度（10 万读/天）会被放大 5 倍消耗。
 */

import type { MoonTVConfig } from './converter';

export const KEYS = {
  configFull: 'config_full',
  configSafe: 'config_safe',
  configFullB58: 'config_full_b58',
  configSafeB58: 'config_safe_b58',
  tvboxFull: 'tvbox_full',
  tvboxSafe: 'tvbox_safe',
  meta: 'meta',
} as const;

export interface Meta {
  site_count: number;
  safe_count: number;
  fetch_count: number;
  error_count: number;
  last_updated: string; // ISO 8601
  last_attempt_at: string; // 最近一次抓取尝试（成功或失败）的时间，用于失败冷却
  last_error: string;
  last_duration_ms: number;
  last_attempts: number;
  source_url: string;
}

export const EMPTY_META: Meta = {
  site_count: 0,
  safe_count: 0,
  fetch_count: 0,
  error_count: 0,
  last_updated: '',
  last_attempt_at: '',
  last_error: '',
  last_duration_ms: 0,
  last_attempts: 0,
  source_url: '',
};

export interface Snapshot {
  configFull: MoonTVConfig;
  configSafe: MoonTVConfig;
  /** 传 undefined 表示「这次没算，保留 KV 里的旧值」，不是「清空」 */
  configFullB58?: string;
  configSafeB58?: string;
  tvboxFull: string;
  tvboxSafe: string;
}

const EMPTY_CONFIG: MoonTVConfig = { cache_time: 7200, api_site: {} };

// ---------------------------------------------------------------------------
// 单 key 读取（请求路径用，一次请求只读 1 个 key）
// ---------------------------------------------------------------------------

export async function readMeta(kv: KVNamespace): Promise<Meta> {
  return (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
}

/** 读 Base58 订阅内容；未生成时返回 null（由调用方决定是否冷启动抓取） */
export async function readConfigB58(kv: KVNamespace, full: boolean): Promise<string | null> {
  return await kv.get(full ? KEYS.configFullB58 : KEYS.configSafeB58);
}

/** 读明文配置；用于 /stats 与调试 */
export async function readConfigJson(kv: KVNamespace, full: boolean): Promise<MoonTVConfig> {
  const cfg = await kv.get<MoonTVConfig>(full ? KEYS.configFull : KEYS.configSafe, 'json');
  return cfg ?? { ...EMPTY_CONFIG };
}

/** 读 TVBox TXT；未生成时返回 null */
export async function readTvbox(kv: KVNamespace, full: boolean): Promise<string | null> {
  return await kv.get(full ? KEYS.tvboxFull : KEYS.tvboxSafe);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export async function writeSnapshot(
  kv: KVNamespace,
  snap: Snapshot,
  metaPatch: Partial<Meta>,
): Promise<Meta> {
  const prev = (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
  const now = new Date().toISOString();
  const meta: Meta = {
    ...EMPTY_META,
    ...prev,
    ...metaPatch,
    fetch_count: prev.fetch_count + 1,
    last_updated: now,
    last_attempt_at: now,
    last_error: '',
  };

  const puts: Promise<void>[] = [
    kv.put(KEYS.configFull, JSON.stringify(snap.configFull)),
    kv.put(KEYS.configSafe, JSON.stringify(snap.configSafe)),
    kv.put(KEYS.tvboxFull, snap.tvboxFull),
    kv.put(KEYS.tvboxSafe, snap.tvboxSafe),
    kv.put(KEYS.meta, JSON.stringify(meta)),
  ];
  // 冷启动只编码被请求的那一份，另一份不动（别把它覆盖成空串）
  if (snap.configFullB58 !== undefined) puts.push(kv.put(KEYS.configFullB58, snap.configFullB58));
  if (snap.configSafeB58 !== undefined) puts.push(kv.put(KEYS.configSafeB58, snap.configSafeB58));

  await Promise.all(puts);

  return meta;
}

/** 只写 Base58 结果（Cron 第二跳用它补编码，避免一次调用里编两份） */
export async function writeConfigB58(kv: KVNamespace, full: boolean, value: string): Promise<void> {
  await kv.put(full ? KEYS.configFullB58 : KEYS.configSafeB58, value);
}

/** 只更新错误信息，不动已抓到的数据（保留旧数据继续对外提供服务） */
export async function writeError(kv: KVNamespace, error: string): Promise<void> {
  const prev = (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
  const meta: Meta = {
    ...prev,
    error_count: prev.error_count + 1,
    last_attempt_at: new Date().toISOString(),
    last_error: error,
  };
  await kv.put(KEYS.meta, JSON.stringify(meta));
}
