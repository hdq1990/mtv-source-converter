# -*- coding: utf-8 -*-
"""
配置常量
所有可调参数集中在此，方便 Docker 环境变量覆盖
"""

import os

# 数据源：ziyuanzu.com 的采集站 JSON 下载链接
# 该文件每 2 小时由网站 CI/CD 自动更新，仅收录可用率 >= 95% 的站点
SOURCE_URL = os.environ.get(
    "SOURCE_URL",
    "https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json"
)

# 定时抓取间隔（秒），默认 2 小时
FETCH_INTERVAL = int(os.environ.get("FETCH_INTERVAL", "7200"))

# HTTP 订阅服务监听地址和端口
HTTP_HOST = os.environ.get("HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))

# MoonTVPlus 配置中的 cache_time（秒）
CACHE_TIME = int(os.environ.get("CACHE_TIME", "7200"))

# 抓取请求超时（秒）
FETCH_TIMEOUT = int(os.environ.get("FETCH_TIMEOUT", "30"))
