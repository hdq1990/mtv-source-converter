# -*- coding: utf-8 -*-
"""
配置常量
所有可调参数集中在此，方便 Docker 环境变量覆盖
"""

import os


def _split(value):
    return [x.strip() for x in (value or "").split(",") if x.strip()]


# 数据源：ziyuanzu.com 的采集站 JSON 下载链接
# 该文件每 2 小时由网站 CI/CD 自动更新，仅收录可用率 >= 95% 的站点
SOURCE_URL = os.environ.get(
    "SOURCE_URL",
    "https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json"
)

# 额外数据源（逗号分隔）。自动识别三种格式：
#   1. 裸采集站数组      [{"name","api",...}]
#   2. MoonTVPlus 明文   {"cache_time":...,"api_site":{...}}
#   3. Base58 订阅串     第 2 种的 Base58 编码
EXTRA_SOURCES = _split(os.environ.get("EXTRA_SOURCES", ""))

# 定时抓取的整点（本地时区的小时数，逗号分隔）。默认每天 01:00 和 13:00 各抓一次。
FETCH_HOURS = [int(h) for h in _split(os.environ.get("FETCH_HOURS", "1,13"))]

# 兼容旧配置：设了 FETCH_INTERVAL 就按固定间隔跑，忽略 FETCH_HOURS
FETCH_INTERVAL = int(os.environ.get("FETCH_INTERVAL", "0") or "0")

# HTTP 订阅服务监听地址和端口
HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))

# MoonTVPlus 配置中的 cache_time（秒）
CACHE_TIME = int(os.environ.get("CACHE_TIME", "7200"))

# 抓取请求超时（秒）
FETCH_TIMEOUT = int(os.environ.get("FETCH_TIMEOUT", "30"))

# 抓取失败重试次数（与 Workers 版的 FETCH_RETRIES 对应）
FETCH_RETRIES = int(os.environ.get("FETCH_RETRIES", "3"))

# 数据超过这么多小时没更新就判定为 stale（与 Workers 版同名变量对应）
STALE_IF_ERROR_HOURS = int(os.environ.get("STALE_IF_ERROR_HOURS", "72"))

# ---- 源可用性探测 ----
# Python 版没有 Workers 的 subrequest 限制，默认一次测完全部源
PROBE_ENABLED = os.environ.get("PROBE_ENABLED", "true").lower() not in ("0", "false", "no")
# 0 = 不限制（全量测）；设成正数则每次最多测这么多
PROBE_LIMIT = int(os.environ.get("PROBE_LIMIT", "0"))
PROBE_TIMEOUT = int(os.environ.get("PROBE_TIMEOUT", "8"))
PROBE_CONCURRENCY = int(os.environ.get("PROBE_CONCURRENCY", "16"))
# 连续失败多少次就从输出里剔除
PROBE_FAIL_THRESHOLD = int(os.environ.get("PROBE_FAIL_THRESHOLD", "2"))
# 探测状态落盘路径（跨重启保留「连续失败几次」的累积，空字符串 = 只在内存里）
_APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROBE_STATE_FILE = os.environ.get(
    "PROBE_STATE_FILE", os.path.join(_APP_DIR, "data", "probe.json")
)