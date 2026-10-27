# -*- coding: utf-8 -*-
"""
HTTP 订阅服务

提供以下路由：
  GET /            - 服务信息页（HTML）
  GET /config.json - MoonTVPlus 配置文件（订阅地址）
  GET /config.txt  - TVBox 风格 TXT 格式
  GET /health      - 健康检查
  GET /stats       - 统计信息

纯 Python 标准库实现，零第三方依赖
"""

import json
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from config import HTTP_HOST, HTTP_PORT, CACHE_TIME


class ConfigStore:
    """线程安全的内存配置存储（支持屏蔽/不屏蔽两个版本）"""

    def __init__(self):
        self._lock = threading.Lock()
        # 不屏蔽版本（全部站点）
        self._config_full = {"cache_time": CACHE_TIME, "api_site": {}}
        self._tvbox_full = ""
        # 屏蔽版本（过滤成人站）
        self._config_safe = {"cache_time": CACHE_TIME, "api_site": {}}
        self._tvbox_safe = ""
        self._last_updated = ""
        self._fetch_count = 0
        self._site_count = 0
        self._safe_count = 0
        self._last_error = ""

    def update(self, config_full, tvbox_full, config_safe, tvbox_safe):
        with self._lock:
            self._config_full = config_full
            self._tvbox_full = tvbox_full
            self._config_safe = config_safe
            self._tvbox_safe = tvbox_safe
            self._last_updated = time.strftime("%Y-%m-%d %H:%M:%S")
            self._fetch_count += 1
            self._site_count = len(config_full.get("api_site", {}))
            self._safe_count = len(config_safe.get("api_site", {}))
            self._last_error = ""

    def mark_error(self, error_msg):
        with self._lock:
            self._last_error = error_msg

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
            return {
                "site_count": self._site_count,
                "safe_count": self._safe_count,
                "fetch_count": self._fetch_count,
                "last_updated": self._last_updated,
                "last_error": self._last_error,
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
            server.shutdown()

    def _make_handler(self):
        store = self.store

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                # 简化日志输出
                print(f"  [{self.address_string()}] {format % args}")

            def _send(self, code, body, content_type="text/plain; charset=utf-8"):
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)

            def _send_json(self, data, code=200):
                body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
                self._send(code, body, "application/json; charset=utf-8")

            def do_GET(self):
                path = self.path.split("?")[0].rstrip("/") or "/"

                if path == "/":
                    self._handle_index()
                elif path == "/config.json":
                    self._handle_config_json(full=True)
                elif path == "/config-safe.json":
                    self._handle_config_json(full=False)
                elif path == "/config.txt":
                    self._handle_config_txt(full=True)
                elif path == "/config-safe.txt":
                    self._handle_config_txt(full=False)
                elif path == "/health":
                    self._handle_health()
                elif path == "/stats":
                    self._handle_stats()
                else:
                    self._send_json({"error": "not found", "path": self.path}, 404)

            def do_HEAD(self):
                self.send_response(200)
                self.end_headers()

            # ---- 路由处理 ----

            def _handle_index(self):
                meta = store.get_meta()
                port = self.server.server_port
                html = f"""<!DOCTYPE html>
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
.ok{{background:#d1fae5;color:#065f46}}.err{{background:#fee2e2;color:#991b1b}}
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
<p>抓取次数: <b>{meta['fetch_count']}</b></p>
<p>最后更新: <b>{meta['last_updated'] or '尚未抓取'}</b></p>
<p>最近错误: {('<span class="err">' + meta['last_error'] + '</span>') if meta['last_error'] else '<span class="ok">无</span>'}</p>
</div>
<div class="card">
<h3>API 端点</h3>
<ul>
<li><a href="/config.json">GET /config.json</a> - 全部站点配置</li>
<li><a href="/config-safe.json">GET /config-safe.json</a> - 屏蔽成人版配置</li>
<li><a href="/config.txt">GET /config.txt</a> - TVBox 全部格式</li>
<li><a href="/config-safe.txt">GET /config-safe.txt</a> - TVBox 屏蔽版格式</li>
<li><a href="/health">GET /health</a> - 健康检查</li>
<li><a href="/stats">GET /stats</a> - 统计信息</li>
</ul>
</div>
</body>
</html>"""
                self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

            def _handle_config_json(self, full=True):
                if full:
                    config = store.get_config_full()
                    label = "全部站点"
                else:
                    config = store.get_config_safe()
                    label = "屏蔽成人版"
                body = json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8")
                print(f"  📡 {label} 订阅: {len(config.get('api_site', {}))} 个站点")
                self._send(200, body, "application/json; charset=utf-8")

            def _handle_config_txt(self, full=True):
                if full:
                    text = store.get_tvbox_full()
                    label = "全部站点"
                else:
                    text = store.get_tvbox_safe()
                    label = "屏蔽成人版"
                if not text:
                    self._send_json({"error": "config not ready"}, 503)
                    return
                print(f"  📡 {label} TXT: {len(text.split(chr(10)))} 行")
                self._send(200, text.encode("utf-8"))

            def _handle_health(self):
                meta = store.get_meta()
                status = "ok" if meta["site_count"] > 0 else "starting"
                self._send_json({"status": status, "sites": meta["site_count"]})

            def _handle_stats(self):
                meta = store.get_meta()
                config_full = store.get_config_full()
                config_safe = store.get_config_safe()
                sites_full = config_full.get("api_site", {})
                sites_safe = config_safe.get("api_site", {})
                self._send_json({
                    **meta,
                    "cache_time": config_full.get("cache_time"),
                    "total_sources": [
                        {"key": k, "name": v["name"], "api": v["api"]}
                        for k, v in sites_full.items()
                    ],
                    "safe_sources": [
                        {"key": k, "name": v["name"], "api": v["api"]}
                        for k, v in sites_safe.items()
                    ],
                })

        return Handler
