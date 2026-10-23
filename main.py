#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MTV Source Converter - 主程序

功能：
  1. 定时从 ziyuanzu.com 抓取采集站清单
  2. 转换为 MoonTVPlus api_site 配置
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
    SOURCE_URL, FETCH_INTERVAL, FETCH_ON_START,
    HTTP_HOST, HTTP_PORT, CACHE_TIME,
)
from fetcher import fetch_with_retry
from converter import convert_to_moontvplus, convert_to_tvbox
from server import ConfigStore, SubscriptionServer


def do_fetch_and_convert(store: ConfigStore):
    """抓取 + 转换 + 更新存储"""
    print(f"[{time.strftime('%H:%M:%S')}] 开始抓取: {SOURCE_URL}")
    sites, error = fetch_with_retry()

    if error or not sites:
        store.mark_error(str(error) if error else "返回空数据")
        print(f"[{time.strftime('%H:%M:%S')}] ❌ 抓取失败: {error}")
        return False

    config = convert_to_moontvplus(sites, cache_time=CACHE_TIME)
    tvbox_text = convert_to_tvbox(sites)

    store.update(config, tvbox_text)
    meta = store.get_meta()
    print(f"[{time.strftime('%H:%M:%S')}] ✅ 抓取成功: {meta['site_count']} 个采集站")
    return True


def fetch_loop(store: ConfigStore, interval: int):
    """定时抓取循环"""
    while True:
        try:
            do_fetch_and_convert(store)
        except Exception as e:
            store.mark_error(str(e))
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️ 抓取异常: {e}")

        # 等待下次抓取（每 60 秒检查一次，便于灵活调整间隔）
        for _ in range(interval // 60):
            time.sleep(60)


def main():
    store = ConfigStore()

    # 调试模式：只抓一次
    if "--once" in sys.argv:
        print("=== 调试模式：单次抓取 ===")
        do_fetch_and_convert(store)
        meta = store.get_meta()
        config = store.get_config()
        print(f"\n站点数: {meta['site_count']}")
        print(f"配置文件示例（前 3 个站点）:")
        print(json.dumps(dict(list(config["api_site"].items())[:3]),
                         ensure_ascii=False, indent=2))
        return

    # 启动时先抓取一次
    if FETCH_ON_START:
        print("=== 启动首次抓取 ===")
        do_fetch_and_convert(store)

    # 启动定时抓取线程
    print(f"=== 定时抓取已启动，间隔 {FETCH_INTERVAL}s ===")
    fetch_thread = threading.Thread(target=fetch_loop, args=(store, FETCH_INTERVAL), daemon=True)
    fetch_thread.start()

    # 启动 HTTP 订阅服务（主线程）
    print(f"=== HTTP 服务配置: {HTTP_HOST}:{HTTP_PORT} ===")
    server = SubscriptionServer(store, host=HTTP_HOST, port=HTTP_PORT)
    server.start()


if __name__ == "__main__":
    main()
