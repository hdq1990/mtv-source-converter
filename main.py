#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MTV Source Converter - 主程序

功能：
  1. 每天 01:00 / 13:00（可由 FETCH_HOURS 改）从多个上游抓采集站清单
  2. 按域名合并去重，剔除探测判定为死源的站点
  3. 转换为 MoonTVPlus api_site 配置（同时在内存里算好 Base58 版本）
  4. 通过 HTTP 提供订阅地址

用法：
  python main.py                # 直接运行
  python main.py --once         # 只抓取一次后退出（调试用）
  python main.py --probe        # 只对现有站点跑一遍可用性探测（调试用）

纯 Python 标准库实现，零第三方依赖，可直接打包为 Docker 镜像
"""

import datetime
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from config import (
    SOURCE_URL, EXTRA_SOURCES, FETCH_HOURS, FETCH_INTERVAL,
    HTTP_HOST, HTTP_PORT, CACHE_TIME,
    PROBE_ENABLED, PROBE_LIMIT, PROBE_TIMEOUT, PROBE_CONCURRENCY, PROBE_FAIL_THRESHOLD,
)
from fetcher import fetch_with_retry, probe_many
from converter import (
    convert_to_moontvplus, convert_to_tvbox, merge_sites, source_summary,
)
from server import ConfigStore, SubscriptionServer


def build_sources():
    """主源 + EXTRA_SOURCES 拼成有序列表，主源永远排第一（去重时优先保留）"""
    sources = [("main", SOURCE_URL)]
    for i, url in enumerate(EXTRA_SOURCES, start=1):
        sources.append((f"extra{i}", url))
    return sources


def run_probe(store, sites):
    """对站点做一次可用性探测并写回 store"""
    if not PROBE_ENABLED or not sites:
        return None

    ordered = sorted(
        sites,
        key=lambda s: (store.probe_last_at(s.get("domain", "")), s.get("domain", "")),
    )
    batch = ordered if PROBE_LIMIT <= 0 else ordered[:PROBE_LIMIT]
    apis = [(s["domain"], s.get("api") or "") for s in batch if s.get("api")]

    print(f"[{time.strftime('%H:%M:%S')}] 🔍 探测 {len(apis)} 个源（并发 {PROBE_CONCURRENCY}）...")
    outcomes = probe_many(apis, timeout=PROBE_TIMEOUT, concurrency=PROBE_CONCURRENCY)
    report = store.apply_probe(outcomes, all_domains={s["domain"] for s in sites})
    print(f"  探测完成：存活 {report['alive']}，"
          f"硬失败 {report['hard_failed']}（4xx/接口不兼容，会剔除），"
          f"软失败 {report['soft_failed']}（超时/网络，只记录）")
    print(f"  累计判定死源 {report['pruned']}，未测过 {report['never_tested']}")
    return report


def do_fetch_and_convert(store: ConfigStore):
    """抓取（多源）+ 合并去重 + 剔除死源 + 转换 + 探测"""
    started = time.time()
    sources = build_sources()
    print(f"[{time.strftime('%H:%M:%S')}] 开始抓取 {len(sources)} 个源: "
          f"{', '.join(u for _, u in sources)}")

    def grab(item):
        label, url = item
        sites, err = fetch_with_retry(url)
        return label, sites, err

    with ThreadPoolExecutor(max_workers=len(sources)) as ex:
        gathered = list(ex.map(grab, sources))

    main_label, main_sites, main_err = gathered[0]
    if main_err or not main_sites:
        msg = str(main_err) if main_err else "主源返回空数据"
        store.mark_error(msg)
        print(f"[{time.strftime('%H:%M:%S')}] ❌ 主源抓取失败: {msg}")
        return False

    groups = [(label, sites) for label, sites, err in gathered if sites]
    for label, sites, err in gathered[1:]:
        if err or not sites:
            print(f"  ⚠️ 附加源 {label} 失败（不影响其它源）: {err}")
        else:
            print(f"  附加源 {label}: {len(sites)} 条")

    merged = merge_sites(groups)
    usable = [s for s in merged if store.probe_fails(s.get("domain", "")) < PROBE_FAIL_THRESHOLD]
    filtered = len(merged) - len(usable)
    if filtered:
        print(f"  已剔除 {filtered} 个探测判定为不可用的源")

    config_full = convert_to_moontvplus(usable, cache_time=CACHE_TIME, filter_adult=False)
    config_safe = convert_to_moontvplus(usable, cache_time=CACHE_TIME, filter_adult=True)
    tvbox_full = convert_to_tvbox(usable, filter_adult=False)
    tvbox_safe = convert_to_tvbox(usable, filter_adult=True)

    duration_ms = int((time.time() - started) * 1000)
    store.update(
        config_full, tvbox_full, config_safe, tvbox_safe,
        duration_ms=duration_ms,
        source_stats=source_summary(groups, merged),
        filtered_count=filtered,
    )

    meta = store.get_meta()
    print(f"[{time.strftime('%H:%M:%S')}] ✅ 合并后 {len(merged)} 站 → 输出 {meta['site_count']} 站"
          f"（屏蔽版 {meta['safe_count']}），耗时 {duration_ms} ms")

    # 探测放在发布之后：探测失败/超时都不影响本次已经发布的数据
    try:
        run_probe(store, merged)
    except Exception as e:
        print(f"  ⚠️ 探测异常（不影响发布）: {e}")

    return True


def next_run_delay(hours):
    """距下一个整点（hours 里的小时）还有多少秒"""
    now = datetime.datetime.now()
    candidates = []
    for h in hours:
        t = now.replace(hour=h, minute=0, second=0, microsecond=0)
        if t <= now:
            t += datetime.timedelta(days=1)
        candidates.append(t)
    return max(1.0, (min(candidates) - now).total_seconds())


def fetch_loop(store: ConfigStore, stop_event: threading.Event):
    """定时抓取循环：按 FETCH_HOURS 定点跑，或按 FETCH_INTERVAL 固定间隔跑"""
    while not stop_event.is_set():
        try:
            do_fetch_and_convert(store)
        except Exception as e:
            store.mark_error(str(e))
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️ 抓取异常: {e}")

        if FETCH_INTERVAL > 0:
            delay = FETCH_INTERVAL
            print(f"  下次抓取：{int(delay)} 秒后（固定间隔）")
        else:
            delay = next_run_delay(FETCH_HOURS)
            nxt = datetime.datetime.now() + datetime.timedelta(seconds=delay)
            print(f"  下次抓取：{nxt.strftime('%Y-%m-%d %H:%M')}"
                  f"（定点 {', '.join(f'{h:02d}:00' for h in FETCH_HOURS)}）")

        # 用 Event.wait 代替 sleep：能被 Ctrl+C / SIGTERM 立即打断
        stop_event.wait(delay)


def main():
    store = ConfigStore(cache_time=CACHE_TIME)

    # 调试模式：只抓一次
    if "--once" in sys.argv:
        print("=== 调试模式：单次抓取 ===")
        do_fetch_and_convert(store)
        meta = store.get_meta()
        config_full = store.get_config_full()
        config_safe = store.get_config_safe()
        print(f"\n站点数: 全部 {meta['site_count']} 个，屏蔽版 {meta['safe_count']} 个"
              f"，剔除死源 {meta['filtered_count']} 个")
        print(f"数据源: {json.dumps(meta['source_stats'], ensure_ascii=False)}")
        print("\n配置文件示例（全部版，前 3 个站点）:")
        print(json.dumps(dict(list(config_full["api_site"].items())[:3]),
                         ensure_ascii=False, indent=2))
        b58 = store.get_b58(True)
        print(f"\nBase58 订阅串长度: {len(b58)} 字符（全部版）")
        return

    # 调试模式：只跑探测
    if "--probe" in sys.argv:
        print("=== 调试模式：可用性探测 ===")
        do_fetch_and_convert(store)  # 先抓一次拿到站点
        report = store.get_probe_report()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return

    # 启动 HTTP 订阅服务（先启动，抓取在后台进行）
    print(f"=== HTTP 服务配置: {HTTP_HOST}:{HTTP_PORT} ===")
    server = SubscriptionServer(store, host=HTTP_HOST, port=HTTP_PORT)

    if FETCH_INTERVAL > 0:
        print(f"=== 定时抓取已启动，间隔 {FETCH_INTERVAL}s ===")
    else:
        print(f"=== 定时抓取已启动，每天 {', '.join(f'{h:02d}:00' for h in FETCH_HOURS)} ===")

    stop_event = threading.Event()
    fetch_thread = threading.Thread(
        target=fetch_loop, args=(store, stop_event), daemon=True
    )
    fetch_thread.start()

    # 启动 HTTP 服务（主线程）
    try:
        server.start()
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()