/**
 * KV 存储层：保存 4 份产物 + 1 份元数据
 *
 * key 约定：
 *   config_full   全部站点 MoonTVPlus JSON（明文，供 /stats 和调试）
 *   config_safe   屏蔽成人版 MoonTVPlus JSON
 *   tvbox_full    TVBox TXT 全部
 *   tvbox_safe    TVBox TXT 屏蔽版
 *   meta          元数据（站点数、抓取次数、最后更新时间、最后错误）
 */

import type { MoonTVConfig } from './converter';

export const KEYS = {
  configFull: 'config_full',
  configSafe: 'config_safe',
  tvboxFull: 'tvbox_full',
  tvboxSafe: 'tvbox_safe',
  meta: 'meta',
} as const;

export interface Meta {
  site_count: number;
  safe_count: number;
  fetch_count: number;
  last_updated: string; // ISO 8601
  last_error: string;
  last_duration_ms: number;
  last_attempts: number;
  source_url: string;
}

export const EMPTY_META: Meta = {
  site_count: 0,
  safe_count: 0,
  fetch_count: 0,
  last_updated: '',
  last_error: '',
  last_duration_ms: 0,
  last_attempts: 0,
  source_url: '',
};

export interface Snapshot {
  configFull: MoonTVConfig;
  configSafe: MoonTVConfig;
  tvboxFull: string;
  tvboxSafe: string;
  meta: Meta;
}

export async function readSnapshot(kv: KVNamespace): Promise<Snapshot> {
  const [configFull, configSafe, tvboxFull, tvboxSafe, meta] = await Promise.all([
    kv.get<MoonTVConfig>(KEYS.configFull, 'json'),
    kv.get<MoonTVConfig>(KEYS.configSafe, 'json'),
    kv.get(KEYS.tvboxFull),
    kv.get(KEYS.tvboxSafe),
    kv.get<Meta>(KEYS.meta, 'json'),
  ]);

  return {
    configFull: configFull ?? { cache_time: 7200, api_site: {} },
    configSafe: configSafe ?? { cache_time: 7200, api_site: {} },
    tvboxFull: tvboxFull ?? '',
    tvboxSafe: tvboxSafe ?? '',
    meta: meta ?? EMPTY_META,
  };
}

export async function writeSnapshot(
  kv: KVNamespace,
  snap: Omit<Snapshot, 'meta'>,
  metaPatch: Partial<Meta>,
): Promise<Meta> {
  const prev = (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
  const meta: Meta = {
    ...EMPTY_META,
    ...prev,
    ...metaPatch,
    fetch_count: prev.fetch_count + 1,
    last_updated: new Date().toISOString(),
    last_error: '',
  };

  await Promise.all([
    kv.put(KEYS.configFull, JSON.stringify(snap.configFull)),
    kv.put(KEYS.configSafe, JSON.stringify(snap.configSafe)),
    kv.put(KEYS.tvboxFull, snap.tvboxFull),
    kv.put(KEYS.tvboxSafe, snap.tvboxSafe),
    kv.put(KEYS.meta, JSON.stringify(meta)),
  ]);

  return meta;
}

export async function writeError(kv: KVNamespace, error: string): Promise<void> {
  const prev = (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
  await kv.put(
    KEYS.meta,
    JSON.stringify({ ...prev, last_error: error } satisfies Meta),
  );
}

export async function readMeta(kv: KVNamespace): Promise<Meta> {
  return (await kv.get<Meta>(KEYS.meta, 'json')) ?? EMPTY_META;
}
