# -*- coding: utf-8 -*-
"""
HTTP 订阅服务

提供以下路由：
  GET /                - 服务信息页（HTML）
  GET /config.json     - 全部站点 MoonTVPlus 配置（Base58 订阅地址）
  GET /config-safe.json - 屏蔽成人版 MoonTVPlus 配置（Base58 订阅地址）
  GET /config.txt      - TVBox 风格 TXT（全部站点）
  GET /config-safe.txt - TVBox 风格 TXT（屏蔽成人版）
  GET /health          - 健康检查
  GET /stats           - 统计信息

纯 Python 标准库实现，零第三方依赖
"""

import html
import json
import os
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from config import HTTP_HOST, HTTP_PORT, CACHE_TIME, STALE_IF_ERROR_HOURS
from config import PROBE_ENABLED, PROBE_FAIL_THRESHOLD, PROBE_STATE_FILE, EXTRA_SOURCES

# Base58 字符集（Bitcoin 标准）
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(data: bytes) -> str:
    """Base58 编码（与 cloudflare/src/base58.ts 输出逐字节一致）"""
    num = int.from_bytes(data, 'big')
    encoded = ""
    while num > 0:
        num, rem = divmod(num, 58)
        encoded = BASE58_ALPHABET[rem] + encoded
    # 处理前导零
    pad = 0
    for byte in data:
        if byte == 0:
            pad += 1
        else:
            break
    return '1' * pad + encoded


class ConfigStore:
    """线程安全的内存配置存储（支持屏蔽/不屏蔽两个版本）"""

    def __init__(self, cache_time=CACHE_TIME):
        self._lock = threading.Lock()
        self._cache_time = cache_time
        # 不屏蔽版本（全部站点）
        self._config_full = {"cache_time": cache_time, "api_site": {}}
        self._tvbox_full = ""
        self._b58_full = ""
        # 屏蔽版本（过滤成人站）
        self._config_safe = {"cache_time": cache_time, "api_site": {}}
        self._tvbox_safe = ""
        self._b58_safe = ""
        self._last_updated = ""
        self._last_updated_ts = 0.0
        self._fetch_count = 0
        self._error_count = 0
        self._site_count = 0
        self._safe_count = 0
        self._last_error = ""
        self._last_duration_ms = 0
        # 探测状态：{domain: {ok, fails, soft, code, detail, ms, last_at}}
        self._probe = {}
        self._probe_updated_at = ""
        self._source_stats = {}
        self._filtered_count = 0
        self._load_probe_state()

    # ---- 探测状态持久化（跨重启保留「连续失败几次」的累积）----

    def _load_probe_state(self):
        if not PROBE_STATE_FILE:
            return
        try:
            with open(PROBE_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("entries"), dict):
                self._probe = data["entries"]
                self._probe_updated_at = data.get("updated_at", "")
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"  ⚠️ 读取探测状态失败（忽略）: {e}")

    def _save_probe_state(self):
        if not PROBE_STATE_FILE:
            return
        try:
            os.makedirs(os.path.dirname(PROBE_STATE_FILE), exist_ok=True)
            tmp = PROBE_STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"updated_at": self._probe_updated_at,
                           "entries": self._probe}, f, ensure_ascii=False)
            os.replace(tmp, PROBE_STATE_FILE)
        except Exception as e:
            print(f"  ⚠️ 写入探测状态失败（忽略）: {e}")

    def update(self, config_full, tvbox_full, config_safe, tvbox_safe, duration_ms=0,
               source_stats=None, filtered_count=0):
        # Base58 编码只在数据更新时做一次（约 20~40ms），请求路径直接取字符串，
        # 避免每次订阅请求都重新编码一遍。
        # 序列化必须用紧凑格式（无缩进、无空格），否则和 Workers 版
        # JSON.stringify() 的字节流不同，Base58 结果也就对不上。
        b58_full = base58_encode(
            json.dumps(config_full, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        b58_safe = base58_encode(
            json.dumps(config_safe, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        with self._lock:
            self._config_full = config_full
            self._tvbox_full = tvbox_full
            self._b58_full = b58_full
            self._config_safe = config_safe
            self._tvbox_safe = tvbox_safe
            self._b58_safe = b58_safe
            self._last_updated = time.strftime("%Y-%m-%d %H:%M:%S")
            self._last_updated_ts = time.time()
            self._fetch_count += 1
            self._site_count = len(config_full.get("api_site", {}))
            self._safe_count = len(config_safe.get("api_site", {}))
            self._last_error = ""
            self._last_duration_ms = duration_ms
            self._source_stats = source_stats or {}
            self._filtered_count = filtered_count

    # ---- 探测状态 ----

    def probe_fails(self, domain):
        with self._lock:
            return (self._probe.get(domain) or {}).get("fails", 0)

    def probe_last_at(self, domain):
        with self._lock:
            return (self._probe.get(domain) or {}).get("last_at", "")

    def apply_probe(self, outcomes, all_domains=None):
        """
        写入一批探测结果。outcomes: {domain: {ok, code, detail, ms, weight}}

        只有 weight=hard 的失败才累计 fails（可能被剔除）；weight=soft
        （超时/连接失败/5xx）单独记在 soft 里，只用于展示 —— 探测端自己网络
        不通时会把大量好源打成红的，直接拿来剔除等于误杀。

        返回汇总报告。
        """
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        alive = hard_failed = soft_failed = 0
        with self._lock:
            for domain, r in outcomes.items():
                prev = self._probe.get(domain) or {}
                hard = (not r.get("ok")) and r.get("weight") == "hard"
                soft = (not r.get("ok")) and r.get("weight") != "hard"
                self._probe[domain] = {
                    "ok": bool(r.get("ok")),
                    "fails": 0 if r.get("ok") else prev.get("fails", 0) + (1 if hard else 0),
                    "soft": 0 if r.get("ok") else prev.get("soft", 0) + (1 if soft else 0),
                    "code": r.get("code", ""),
                    "detail": str(r.get("detail", ""))[:120],
                    "ms": int(r.get("ms", 0)),
                    "last_at": now,
                }
                if r.get("ok"):
                    alive += 1
                elif hard:
                    hard_failed += 1
                else:
                    soft_failed += 1
            self._probe_updated_at = now

            domains = all_domains if all_domains is not None else set(self._probe)
            never = sum(1 for d in domains if d not in self._probe)
            pruned = sum(1 for d in domains
                         if (self._probe.get(d) or {}).get("fails", 0) >= PROBE_FAIL_THRESHOLD)

        self._save_probe_state()
        return {
            "tested": len(outcomes),
            "alive": alive,
            "hard_failed": hard_failed,
            "soft_failed": soft_failed,
            "never_tested": never,
            "pruned": pruned,
        }

    def get_probe_report(self):
        """给 /sources 用的探测明细"""
        with self._lock:
            entries = dict(self._probe)
            updated = self._probe_updated_at
        rows = []
        for domain, e in sorted(entries.items()):
            if e["ok"]:
                state = "alive"
            elif e["fails"] >= PROBE_FAIL_THRESHOLD:
                state = "dead"
            elif e.get("code") in ("network", "timeout"):
                # 探测端自己打不通，不能断定源坏了
                state = "unreachable"
            else:
                state = "flaky"
            rows.append({"domain": domain, "state": state, **{
                k: e.get(k) for k in ("ok", "fails", "soft", "code", "detail", "ms", "last_at")
            }})
        counts = {"alive": 0, "flaky": 0, "unreachable": 0, "dead": 0, "untested": 0}
        for r in rows:
            counts[r["state"]] += 1
        return {
            "probe_updated_at": updated or None,
            "fail_threshold": PROBE_FAIL_THRESHOLD,
            "counts": counts,
            "sites": rows,
        }

    def mark_error(self, error_msg):
        with self._lock:
            self._last_error = error_msg
            self._error_count += 1

    def is_ready(self):
        with self._lock:
            return bool(self._b58_full)

    def get_b58(self, full=True):
        with self._lock:
            return self._b58_full if full else self._b58_safe

    def get_config_full(self):
        with self._lock:
            return dict(self._config_full)

    def get_config_safe(self):
        with self._lock:
            return dict(self._config_safe)

    def get_tvbox_full(self):
        with self._lock:
            return self._tvbox_full

    def get_tvbox_safe(self):
        with self._lock:
            return self._tvbox_safe

    def get_meta(self):
        with self._lock:
            age = None
            if self._last_updated_ts:
                age = int(time.time() - self._last_updated_ts)
            stale = bool(age is not None and age > STALE_IF_ERROR_HOURS * 3600)
            if self._site_count == 0:
                status = "starting"
            elif stale:
                status = "stale"
            else:
                status = "ok"
            return {
                "status": status,
                "site_count": self._site_count,
                "safe_count": self._safe_count,
                "filtered_count": self._filtered_count,
                "source_stats": self._source_stats,
                "fetch_count": self._fetch_count,
                "error_count": self._error_count,
                "last_updated": self._last_updated,
                "age_seconds": age,
                "stale_after_hours": STALE_IF_ERROR_HOURS,
                "last_error": self._last_error,
                "last_duration_ms": self._last_duration_ms,
            }


class SubscriptionServer:
    """HTTP 订阅服务"""

    def __init__(self, store: ConfigStore, host=HTTP_HOST, port=HTTP_PORT):
        self.store = store
        self.host = host
        self.port = port

    def start(self):
        handler = self._make_handler()
        server = ThreadingHTTPServer((self.host, self.port), handler)
        print(f"HTTP 订阅服务已启动: http://{self.host}:{self.port}")
        print(f"  MoonTVPlus 订阅地址: http://<本机IP>:{self.port}/config.json")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n正在停止服务...")
        finally:
            # 注意：不能在 serve_forever() 已被 KeyboardInterrupt 打断后调用
            # server.shutdown()——它会等一个永远不会被设置的事件，直接死锁。
            server.server_close()

    def _make_handler(self):
        store = self.store

        class Handler(BaseHTTPRequestHandler):
            server_version = "MTVSourceConverter/1.0"
            sys_version = ""
            # HTTP/1.1 才能复用连接（订阅客户端一般是 keep-alive）；
            # 所有响应都带 Content-Length，所以不需要 chunked 或 close 兜底
            protocol_version = "HTTP/1.1"

            def version_string(self):
                # 默认实现是 server_version + ' ' + sys_version，会留个尾空格
                return self.server_version

            def log_message(self, format, *args):
                # 简化日志输出：只记录 GET / HEAD 请求
                msg = format % args
                if "GET" in msg or "HEAD" in msg:
                    print(f"  {msg}")

            def _send(self, code, body, content_type="text/plain; charset=utf-8",
                      extra_headers=None, head_only=False):
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                headers = {"Cache-Control": "no-cache"}
                headers.update(extra_headers or {})
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                if not head_only:
                    self.wfile.write(body)

            def _send_json(self, data, code=200, extra_headers=None, head_only=False):
                body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
                self._send(code, body, "application/json; charset=utf-8",
                           extra_headers, head_only)

            def _route(self, head_only=False):
                path = self.path.split("?")[0].rstrip("/") or "/"

                if path == "/":
                    self._handle_index(head_only)
                elif path == "/config.json":
                    self._handle_config_json(True, head_only)
                elif path == "/config-safe.json":
                    self._handle_config_json(False, head_only)
                elif path == "/config.txt":
                    self._handle_config_txt(True, head_only)
                elif path == "/config-safe.txt":
                    self._handle_config_txt(False, head_only)
                elif path == "/health":
                    self._handle_health(head_only)
                elif path == "/stats":
                    self._handle_stats(head_only)
                elif path == "/sources":
                    self._handle_sources(head_only)
                else:
                    self._send_json({"error": "not found", "path": self.path}, 404,
                                    head_only=head_only)

            def do_GET(self):
                self._route(False)

            def do_HEAD(self):
                # 与 GET 走同一套路由，只是不写 body —— 原来无条件返回 200 会让
                # 监控误判 404 路径为健康
                self._route(True)

            def _method_not_allowed(self):
                # 不覆盖这些方法时 BaseHTTPRequestHandler 会回 501，
                # 语义上应该是 405（与 Workers 版对齐）
                self._send_json(
                    {"error": "method not allowed", "allow": "GET, HEAD"},
                    405,
                    {"Allow": "GET, HEAD"},
                )

            do_POST = _method_not_allowed
            do_PUT = _method_not_allowed
            do_DELETE = _method_not_allowed
            do_PATCH = _method_not_allowed
            do_OPTIONS = _method_not_allowed

            # ---- 路由处理 ----

            def _handle_index(self, head_only=False):
                meta = store.get_meta()
                port = self.server.server_port
                err = meta["last_error"]
                err_html = (
                    f'<span class="err">{html.escape(err)}</span>' if err
                    else '<span class="ok">无</span>'
                )
                stale_html = (
                    '<span class="err">数据已超过 {} 小时未更新</span>'.format(
                        meta["stale_after_hours"])
                    if meta["status"] == "stale" else '<span class="ok">正常</span>'
                )
                page = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MTV Source Converter - 订阅服务</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#333}}
h1{{color:#2563eb}}.card{{border:1px solid #e0e0e0;border-radius:8px;padding:1rem;margin:1rem 0}}
code{{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:.9em}}
a{{color:#2563eb;text-decoration:none}}a:hover{{text-decoration:underline}}
.badge{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.8em}}
.ok{{color:#059669}}.err{{color:#dc2626}}
.sub{{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #eee}}
.sub-label{{font-weight:bold;width:120px;flex-shrink:0}}
.sub-url{{font-family:monospace;font-size:.85em;color:#2563eb}}
.sub-count{{margin-left:auto;font-size:.8em;color:#666}}
</style>
</head>
<body>
<h1>🎬 MTV Source Converter</h1>
<p>定时从 ziyuanzu.com 抓取采集站清单，转换为 MoonTVPlus 可用配置。</p>
<div class="card">
<h3>📡 订阅地址（两个版本）</h3>
<div class="sub">
<span class="sub-label">📦 全部站点</span>
<a href="/config.json"><code>http://&lt;本机IP&gt;:{port}/config.json</code></a>
<span class="sub-count">{meta['site_count']} 个站点</span>
</div>
<div class="sub">
<span class="sub-label">🛡️ 屏蔽成人版</span>
<a href="/config-safe.json"><code>http://&lt;本机IP&gt;:{port}/config-safe.json</code></a>
<span class="sub-count">{meta['safe_count']} 个站点</span>
</div>
<div class="sub">
<span class="sub-label">📄 TVBox 全部</span>
<a href="/config.txt"><code>http://&lt;本机IP&gt;:{port}/config.txt</code></a>
</div>
<div class="sub">
<span class="sub-label">📄 TVBox 屏蔽版</span>
<a href="/config-safe.txt"><code>http://&lt;本机IP&gt;:{port}/config-safe.txt</code></a>
</div>
</div>
<div class="card">
<h3>运行状态</h3>
<p>全部站点: <b>{meta['site_count']}</b> · 屏蔽版: <b>{meta['safe_count']}</b></p>
<p>探测剔除: <b>{meta['filtered_count']}</b> 个死源 · 数据源: <b>{len(meta['source_stats'])}</b> 个</p>
<p>抓取成功: <b>{meta['fetch_count']}</b> 次 · 失败: <b>{meta['error_count']}</b> 次</p>
<p>最后更新: <b>{meta['last_updated'] or '尚未抓取'}</b></p>
<p>数据新鲜度: {stale_html}</p>
<p>最近错误: {err_html}</p>
</div>
<div class="card">
<h3>API 端点</h3>
<ul>
<li><a href="/config.json">GET /config.json</a> - 全部站点配置（Base58）</li>
<li><a href="/config-safe.json">GET /config-safe.json</a> - 屏蔽成人版配置（Base58）</li>
<li><a href="/config.txt">GET /config.txt</a> - TVBox 全部格式</li>
<li><a href="/config-safe.txt">GET /config-safe.txt</a> - TVBox 屏蔽版格式</li>
<li><a href="/health">GET /health</a> - 健康检查</li>
<li><a href="/stats">GET /stats</a> - 统计信息</li>
<li><a href="/sources">GET /sources</a> - 每个源的探测结果</li>
</ul>
</div>
</body>
</html>"""
                self._send(200, page.encode("utf-8"), "text/html; charset=utf-8",
                           head_only=head_only)

            def _handle_config_json(self, full=True, head_only=False):
                # MoonTVPlus 订阅地址要求 Base58 编码的 JSON；编码结果在
                # ConfigStore.update() 里已经算好，这里只是取字符串
                encoded = store.get_b58(full)
                if not encoded:
                    self._send_json(
                        {"error": "config not ready",
                         "detail": "尚未抓取到数据，请稍后重试"},
                        503,
                        {"Retry-After": "60", "Cache-Control": "no-store"},
                        head_only,
                    )
                    return
                self._send(200, encoded.encode("utf-8"), "text/plain; charset=utf-8",
                           {"Cache-Control": "public, max-age=300"},
                           head_only)

            def _handle_config_txt(self, full=True, head_only=False):
                text = store.get_tvbox_full() if full else store.get_tvbox_safe()
                if not text:
                    self._send_json({"error": "config not ready"}, 503,
                                    {"Retry-After": "60", "Cache-Control": "no-store"},
                                    head_only)
                    return
                self._send(200, text.encode("utf-8"), "text/plain; charset=utf-8",
                           {"Cache-Control": "public, max-age=300"}, head_only)

            def _handle_health(self, head_only=False):
                meta = store.get_meta()
                self._send_json({
                    "status": meta["status"],
                    "sites": meta["site_count"],
                    "safe_sites": meta["safe_count"],
                    "filtered": meta["filtered_count"],
                    "sources": meta["source_stats"],
                    "last_updated": meta["last_updated"] or None,
                    "age_seconds": meta["age_seconds"],
                    "stale_after_hours": meta["stale_after_hours"],
                    "fetch_count": meta["fetch_count"],
                    "error_count": meta["error_count"],
                    "last_error": meta["last_error"] or None,
                }, head_only=head_only)

            def _handle_sources(self, head_only=False):
                """每个源的探测结果，方便判断哪个上游在拖后腿"""
                meta = store.get_meta()
                report = store.get_probe_report()
                config_full = store.get_config_full()
                # 把探测结果按站点补全（含名字和 api）
                by_domain = {r["domain"]: r for r in report["sites"]}
                rows = []
                for key, v in config_full.get("api_site", {}).items():
                    domain = ""
                    try:
                        from urllib.parse import urlparse as _up
                        domain = (_up(v.get("api") or "").netloc or "").lower().replace("www.", "")
                    except ValueError:
                        pass
                    e = by_domain.get(domain)
                    rows.append({
                        "key": key,
                        "domain": domain,
                        "name": v.get("name"),
                        "api": v.get("api"),
                        "state": (e or {}).get("state", "untested"),
                        "fails": (e or {}).get("fails", 0),
                        "code": (e or {}).get("code"),
                        "detail": (e or {}).get("detail"),
                        "last_ms": (e or {}).get("ms"),
                        "last_probe": (e or {}).get("last_at"),
                    })
                self._send_json({
                    **report,
                    "probe_enabled": PROBE_ENABLED,
                    "extra_sources": EXTRA_SOURCES,
                    "source_stats": meta["source_stats"],
                    "filtered_from_output": meta["filtered_count"],
                    "sites": rows,
                }, head_only=head_only)

            def _handle_stats(self, head_only=False):
                meta = store.get_meta()
                config_full = store.get_config_full()
                config_safe = store.get_config_safe()
                sites_full = config_full.get("api_site", {})
                sites_safe = config_safe.get("api_site", {})
                self._send_json({
                    **meta,
                    "cache_time": config_full.get("cache_time"),
                    "total_sources": [
                        {"key": k, "name": v.get("name"), "api": v.get("api")}
                        for k, v in sites_full.items()
                    ],
                    "safe_sources": [
                        {"key": k, "name": v.get("name"), "api": v.get("api")}
                        for k, v in sites_safe.items()
                    ],
                }, head_only=head_only)

        return Handler
