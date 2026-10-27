/**
 * 配置模块
 * 所有可调参数集中在此，方便 wrangler.toml 环境变量覆盖
 */

export const SOURCE_URL = "https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json";

// 定时抓取间隔（秒），默认 2 小时
export const FETCH_INTERVAL = 7200;

// MoonTVPlus 配置中的 cache_time（秒）
export const CACHE_TIME = 7200;

// KV 存储的 key
export const KV_KEY_FULL = "config_full";       // 全部站点配置
export const KV_KEY_SAFE = "config_safe";        // 屏蔽成人版配置
export const KV_KEY_TVBOX_FULL = "tvbox_full";    // TVBox 全部
export const KV_KEY_TVBOX_SAFE = "tvbox_safe";    // TVBox 屏蔽版
export const KV_KEY_META = "meta";                // 元数据（站点数、抓取次数等）
