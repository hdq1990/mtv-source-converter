# -*- coding: utf-8 -*-
"""
抓取模块：从 ziyuanzu.com 下载采集站清单

纯 Python 标准库实现，零第三方依赖
"""

import json
import ssl
import time
import urllib.request
import urllib.error

from config import SOURCE_URL, FETCH_TIMEOUT, FETCH_RETRIES


class FatalFetchError(Exception):
    """重试也不会自愈的错误（响应不是数组、空数组、JSON 解析失败）"""


def fetch_sites(url=SOURCE_URL, timeout=FETCH_TIMEOUT):
    """
    从 ziyuanzu.com 下载采集站 JSON 清单

    返回: list[dict]，每个 dict 包含 name/api/apiType/uptime 等字段
    异常: 抛出 urllib.error.URLError、FatalFetchError 或 json.JSONDecodeError
    """
    # 使用默认 SSL 验证（关闭验证会导致握手超时）
    ctx = ssl.create_default_context()

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

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise FatalFetchError(
            f"响应不是合法 JSON（前 80 字符：{text[:80]!r}）: {e}"
        ) from e

    if not isinstance(data, list):
        raise FatalFetchError(f"期望 JSON 数组，实际得到 {type(data).__name__}")

    if not data:
        raise FatalFetchError("上游返回空数组")

    return data


def fetch_with_retry(url=SOURCE_URL, timeout=FETCH_TIMEOUT, retries=FETCH_RETRIES):
    """
    带重试的抓取，失败时等待指数退避后重试

    返回: (sites, error)  成功时 error 为 None
    """
    retries = max(1, int(retries))
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            sites = fetch_sites(url, timeout)
            return sites, None
        except FatalFetchError as e:
            # 数据格式问题：等再久也不会变，直接放弃，保留上一次的好数据
            print(f"  抓取失败（不可重试）: {e}")
            return None, e
        except Exception as e:
            last_error = e
            if attempt < retries:
                wait = 2 ** attempt
                print(f"  抓取失败（第 {attempt} 次），{wait}s 后重试... 错误: {e}")
                time.sleep(wait)
            else:
                print(f"  抓取失败（第 {attempt} 次），放弃: {e}")
    return None, last_error
