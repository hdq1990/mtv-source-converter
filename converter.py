# -*- coding: utf-8 -*-
"""
转换模块：将采集站清单转换为 MoonTVPlus api_site 配置

MoonTVPlus 的 api_site 仅支持 type=0（苹果 CMS V10），
ziyuanzu.com 的采集站全部是苹果 CMS V10 的 /api.php/provide/vod/ json 接口，
因此可以直接转换使用。

纯 Python 标准库实现，零第三方依赖
"""

import re
from urllib.parse import urlparse

from config import CACHE_TIME

# 成人站过滤关键词（按名称匹配）
ADULT_NAME_KEYWORDS = [
    "湿乐园", "番号", "麻豆", "色仓库", "黑料", "搜A-V",
    "白嫖", "美少女", "色A-V", "清水源", "香系源", "老色X",
    "色猫", "精品X", "大X子",
]

# 成人站过滤关键词（按域名匹配）
ADULT_DOMAIN_KEYWORDS = [
    "xxavs", "fhapi", "91md", "hsckzy", "heiliaozy", "souav",
    "kxgav", "msnii", "pgxdy", "xrbsp", "gdlsp", "apilsbzy",
    "semaozy", "jingpinx", "apidanaizi",
]


def make_key(site, used_keys):
    """
    从站点 API 域名生成唯一的小写字母/数字 key

    MoonTVPlus 要求 key 为小写字母/数字，作为站点的唯一标识，
    用于搜索、播放记录同步等功能。
    """
    api = site.get("api", "") or site.get("apiUrl", "")
    domain = urlparse(api).netloc.lower() if api else ""
    domain = domain.replace("www.", "")
    # 取第一个子域片段作为 key 基础
    first_part = domain.split(".")[0] if domain else "site"
    key = re.sub(r"[^a-z0-9]", "", first_part)
    if not key:
        key = "site"
    # 去重：若已存在则加数字后缀
    base = key
    n = 1
    while key in used_keys:
        n += 1
        key = f"{base}{n}"
    return key


def should_filter_adult(site):
    """
    判断是否为成人站

    返回: True 表示应过滤（成人站）
    """
    name = site.get("name", "")
    api = site.get("api") or site.get("apiUrl", "")
    domain = urlparse(api).netloc.lower() if api else ""

    for kw in ADULT_NAME_KEYWORDS:
        if kw in name:
            return True
    for kw in ADULT_DOMAIN_KEYWORDS:
        if kw in domain:
            return True
    return False


def convert_to_moontvplus(sites, cache_time=CACHE_TIME, filter_adult=False):
    """
    将采集站清单转换为 MoonTVPlus 配置文件格式

    参数:
        sites: list[dict] - 采集站清单
        cache_time: int - 接口缓存时间（秒）
        filter_adult: bool - 是否过滤成人站

    返回: dict - MoonTVPlus 可直接使用的配置文件
    """
    api_site = {}
    used_keys = set()

    for site in sites:
        if filter_adult and should_filter_adult(site):
            continue

        key = make_key(site, used_keys)
        used_keys.add(key)

        # 兼容字段名：api / apiUrl
        api = site.get("api") or site.get("apiUrl", "")
        name = site.get("name", "")

        entry = {
            "api": api,
            "name": name,
        }
        api_site[key] = entry

    config = {
        "cache_time": cache_time,
        "api_site": api_site,
    }
    return config


def convert_to_tvbox(sites, filter_adult=False):
    """
    将采集站清单转换为 TVBox 风格的 TXT 格式

    返回: str - 每行一个采集站，管道符分隔
    """
    lines = []
    for site in sites:
        if filter_adult and should_filter_adult(site):
            continue
        api = site.get("api") or site.get("apiUrl", "")
        name = site.get("name", "")
        uptime = site.get("uptime", "")
        api_type = site.get("apiType", "json")
        lines.append(f"{name}|{api}|{api_type}|{uptime}")
    return "\n".join(lines)
