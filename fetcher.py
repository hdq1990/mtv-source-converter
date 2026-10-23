# -*- coding: utf-8 -*-
"""
抓取模块：从 ziyuanzu.com 下载采集站清单

纯 Python 标准库实现，零第三方依赖
"""

import json
import ssl
import urllib.request
import urllib.error

from config import SOURCE_URL, FETCH_TIMEOUT


def fetch_sites(url=SOURCE_URL, timeout=FETCH_TIMEOUT):
    """
    从 ziyuanzu.com 下载采集站 JSON 清单

    返回: list[dict]，每个 dict 包含 name/api/apiType/uptime 等字段
    异常: 抛出 urllib.error.URLError 或 json.JSONDecodeError
    """
    # ziyuanzu.com 的 SSL 证书可能在某些环境下有问题，跳过验证
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })

    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()

    # 尝试 UTF-8 解码，失败则用 GBK 兜底
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")

    data = json.loads(text)

    if not isinstance(data, list):
        raise ValueError(f"期望 JSON 数组，实际得到 {type(data).__name__}")

    return data


def fetch_with_retry(url=SOURCE_URL, timeout=FETCH_TIMEOUT, retries=3):
    """
    带重试的抓取，失败时等待指数退避后重试

    返回: (sites, error)  成功时 error 为 None
    """
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            sites = fetch_sites(url, timeout)
            return sites, None
        except Exception as e:
            last_error = e
            if attempt < retries:
                import time
                wait = 2 ** attempt
                print(f"  抓取失败（第 {attempt} 次），{wait}s 后重试... 错误: {e}")
                time.sleep(wait)
            else:
                print(f"  抓取失败（第 {attempt} 次），放弃: {e}")
    return None, last_error
