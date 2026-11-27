#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MTV Source Converter - 主程序

功能：
  1. 定时从 ziyuanzu.com 抓取采集站清单
  2. 转换为 MoonTVPlus api_site 配置（同时在内存里算好 Base58 版本）
  3. 通过 HTTP 提供订阅地址

用法：
  python main.py                # 直接运行
  python main.py --once         # 只抓取一次后退出（调试用）

纯 Python 标准库实现，零第三方依赖，可直接打包为 Docker 镜像
"""

import json
import sys
import threading
import time

from config import (
    SOURCE_URL, FETCH_INTERVAL,
    HTTP_HOST, HTTP_PORT, CACHE_TIME,
)
from fetcher import fetch_with_retry
from converter import convert_to_moontvplus, convert_to_tvbox
from server import ConfigStore, SubscriptionServer


def do_fetch_and_convert(store: ConfigStore):
    """抓取 + 转换（生成屏蔽/不屏蔽两个版本）+ 更新存储"""
    print(f"[{time.strftime('%H:%M:%S')}] 开始抓取: {SOURCE_URL}")
    started = time.time()
    sites, error = fetch_with_retry()

    if error or not sites:
        store.mark_error(str(error) if error else "返回空数据")
        print(f"[{time.strftime('%H:%M:%S')}] ❌ 抓取失败: {error}")
        return False

    # 生成两个版本：不屏蔽（全部）和屏蔽成人
    config_full = convert_to_moontvplus(sites, cache_time=CACHE_TIME, filter_adult=False)
    config_safe = convert_to_moontvplus(sites, cache_time=CACHE_TIME, filter_adult=True)
    tvbox_full = convert_to_tvbox(sites, filter_adult=False)
    tvbox_safe = convert_to_tvbox(sites, filter_adult=True)

    duration_ms = int((time.time() - started) * 1000)
    store.update(config_full, tvbox_full, config_safe, tvbox_safe, duration_ms)
    meta = store.get_meta()
    print(f"[{time.strftime('%H:%M:%S')}] ✅ 抓取成功: {meta['site_count']} 个采集站（全部）")
    print(f"  屏蔽版: {meta['safe_count']} 个采集站，耗时 {duration_ms} ms")
    return True


def fetch_loop(store: ConfigStore, interval: int, stop_event: threading.Event):
    """定时抓取循环"""
    while not stop_event.is_set():
        try:
            do_fetch_and_convert(store)
        except Exception as e:
            store.mark_error(str(e))
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️ 抓取异常: {e}")

        # 用 Event.wait 代替逐分钟 sleep：原来的 range(interval // 60) 在
        # FETCH_INTERVAL < 60 时 range(0) 为空，会退化成 while True 疯狂抓取；
        # 同时 wait 能被 Ctrl+C / SIGTERM 立即打断
        stop_event.wait(interval)


def main():
    store = ConfigStore(cache_time=CACHE_TIME)

    # 调试模式：只抓一次
    if "--once" in sys.argv:
        print("=== 调试模式：单次抓取 ===")
        do_fetch_and_convert(store)
        meta = store.get_meta()
        config_full = store.get_config_full()
        config_safe = store.get_config_safe()
        print(f"\n站点数: 全部 {meta['site_count']} 个，屏蔽版 {meta['safe_count']} 个")
        print("\n配置文件示例（全部版，前 3 个站点）:")
        print(json.dumps(dict(list(config_full["api_site"].items())[:3]),
                         ensure_ascii=False, indent=2))
        print("\n配置文件示例（屏蔽版，前 3 个站点）:")
        print(json.dumps(dict(list(config_safe["api_site"].items())[:3]),
                         ensure_ascii=False, indent=2))
        b58 = store.get_b58(True)
        print(f"\nBase58 订阅串长度: {len(b58)} 字符（全部版）")
        return

    # 启动 HTTP 订阅服务（先启动，抓取在后台进行）
    print(f"=== HTTP 服务配置: {HTTP_HOST}:{HTTP_PORT} ===")
    server = SubscriptionServer(store, host=HTTP_HOST, port=HTTP_PORT)

    # 启动定时抓取线程（后台运行）
    print(f"=== 定时抓取已启动，间隔 {FETCH_INTERVAL}s ===")
    stop_event = threading.Event()
    fetch_thread = threading.Thread(
        target=fetch_loop, args=(store, FETCH_INTERVAL, stop_event), daemon=True
    )
    fetch_thread.start()

    # 启动 HTTP 服务（主线程）
    try:
        server.start()
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()
