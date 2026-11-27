# -*- coding: utf-8 -*-
"""
抓取模块：多格式上游清单 + 源可用性探测

上游支持三种格式，自动识别：
  1. 裸采集站数组      [{"name","api","apiType","uptime"}, ...]
  2. MoonTVPlus 配置   {"cache_time":7200,"api_site":{"k":{"api","name"}}}
  3. Base58 订阅串     第 2 种的 Base58 编码

纯 Python 标准库实现，零第三方依赖
"""

import json
import ssl
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

from config import SOURCE_URL, FETCH_TIMEOUT, FETCH_RETRIES

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(BASE58_ALPHABET)}

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


class FatalFetchError(Exception):
    """重试也不会自愈的错误（格式不对、空数组、解码失败）"""


def base58_decode(text):
    """Base58 解码（与 cloudflare/src/base58.ts 的 base58Decode 等价）"""
    s = text.strip()
    if not s:
        return b""
    num = 0
    for ch in s:
        idx = _B58_INDEX.get(ch)
        if idx is None:
            raise ValueError(f"非法 base58 字符：{ch!r}")
        num = num * 58 + idx
    pad = len(s) - len(s.lstrip("1"))
    body = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    return b"\x00" * pad + body


def looks_like_base58(text):
    if len(text) < 32:
        return False
    return all(c in _B58_INDEX for c in text)


def parse_source_body(text):
    """把任意格式的响应体解析成采集站列表"""
    trimmed = (text or "").strip()
    if not trimmed:
        raise FatalFetchError("响应为空")

    via = "json"
    try:
        data = json.loads(trimmed)
    except json.JSONDecodeError:
        if not looks_like_base58(trimmed):
            raise FatalFetchError(f"响应不是合法 JSON（前 80 字符：{trimmed[:80]!r}）")
        try:
            data = json.loads(base58_decode(trimmed).decode("utf-8"))
            via = "base58"
        except Exception as e:
            raise FatalFetchError(f"Base58 解码失败：{e}") from e

    if isinstance(data, list):
        if not data:
            raise FatalFetchError("上游返回空数组")
        return data

    if isinstance(data, dict):
        api_site = data.get("api_site")
        if isinstance(api_site, dict):
            sites = []
            for key, raw in api_site.items():
                v = raw or {}
                api = v.get("api") or v.get("apiUrl") or ""
                if isinstance(api, str) and api.startswith("http"):
                    sites.append({"name": v.get("name") or key, "api": api})
            if not sites:
                raise FatalFetchError(f"配置对象里没有可用的 api（via {via}）")
            return sites
        raise FatalFetchError(
            f"JSON 对象里找不到 api_site（via {via}，顶层键：{list(data)[:5]}）"
        )

    raise FatalFetchError(f"期望数组或配置对象，实际得到 {type(data).__name__}")


def fetch_sites(url=SOURCE_URL, timeout=FETCH_TIMEOUT):
    """下载并解析一个上游源，返回 list[dict]"""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })

    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")

    return parse_source_body(text)


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


# ---------------------------------------------------------------------------
# 源可用性探测
# ---------------------------------------------------------------------------

def probe_api(api, timeout=8):
    """
    探测一个采集站 API 是否可用。

    地址拼接：只有 api 本身不带 query 时才追加 `?ac=detail&pg=1`。
    带 query 的多半是「代理型」地址（如 `https://proxy/?url=https://x/api.php`），
    再拼一个 `&ac=...` 会被代理当作目标 URL 的一部分，直接 404。

    返回: dict(ok, code, detail, ms, weight)
      weight = "hard" 表示「源本身有问题」（4xx / 返回 RSS 接口）→ 可剔除
      weight = "soft" 表示「可能只是探测端网络问题」（超时/连接失败/5xx）→ 只记录
    """
    started = time.time()
    url = api if "?" in api else api.rstrip("/") + "?ac=detail&pg=1"

    def ms():
        return int((time.time() - started) * 1000)

    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "application/json, text/plain, */*"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read(4096).decode("utf-8", errors="replace").strip()
            status = resp.status
    except urllib.error.HTTPError as e:
        hard = 400 <= e.code < 500
        return {"ok": False, "code": "http", "detail": f"HTTP {e.code}",
                "ms": ms(), "weight": "hard" if hard else "soft"}
    except Exception as e:
        name = type(e).__name__
        code = "timeout" if "timed out" in str(e).lower() or name == "timeout" else "network"
        return {"ok": False, "code": code, "detail": str(e)[:120],
                "ms": ms(), "weight": "soft"}

    if status >= 400:
        hard = status < 500
        return {"ok": False, "code": "http", "detail": f"HTTP {status}",
                "ms": ms(), "weight": "hard" if hard else "soft"}

    head = body
    looks_json = head.startswith("{") or head.startswith("[")
    has_list = '"list"' in head or '"data"' in head or '"code"' in head
    if looks_json and has_list:
        return {"ok": True, "code": "ok", "detail": "json", "ms": ms(), "weight": "soft"}

    # RSS/XML：接口类型不对，MoonTVPlus 的 type=0 只吃苹果 CMS JSON → 硬证据
    is_xml = head.startswith("<?xml") or head.startswith("<rss") or "<rss" in head
    # HTML：多半是错误页/跳转页，可能是临时问题 → 软证据
    is_html = head.startswith("<!DOCTYPE") or head.startswith("<html") or "<html" in head
    detail = ("RSS/XML（接口类型不兼容）" if is_xml
              else "HTML（疑似错误页）" if is_html
              else (head[:60] or "(空响应)"))
    return {"ok": False, "code": "bad_body", "detail": detail,
            "ms": ms(), "weight": "hard" if is_xml else "soft"}


def probe_many(apis, timeout=8, concurrency=16):
    """
    并发探测。apis 是 [(key, api_url), ...]，返回 {key: outcome}
    """
    if not apis:
        return {}

    def run(item):
        key, api = item
        return key, probe_api(api, timeout)

    out = {}
    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(apis)))) as ex:
        for key, outcome in ex.map(run, apis):
            out[key] = outcome
    return out