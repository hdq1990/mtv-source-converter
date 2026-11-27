# MTV Source Converter — Cloudflare Workers 版

零服务器、免费套餐即可运行的 MoonTVPlus 配置订阅服务。抓取逻辑、转换规则、路由与 Python 版 **1:1 对齐**，输出 Base58 编码结果逐字节一致。

## 架构

```
Cron Trigger（每 2h）──► fetch ziyuanzu.com ──► convert ──► KV（5 个 key）
                                                           │
GET /config.json ──────────────────────────────────────────┴──► 直接读 KV 返回
GET /config.json（KV 为空）──► 请求内实时抓取 + 回写 KV（冷启动兜底）
```

| 组件 | 作用 | 免费额度 |
|---|---|---|
| Workers | 路由 + 抓取 + 转换 | 10 万请求/天 |
| KV | 存 4 份产物 + 1 份元数据 | 10 万读 / 1000 写 每天 |
| Cron Triggers | 定时触发 | 免费，12 次/天 |
| Observability | 日志 | 免费 20 万事件/天 |

订阅场景每天几十次请求，额度绰绰有余。

## 部署步骤

### 前置条件

- Node.js ≥ 18
- 一个 Cloudflare 账号（免费）
- 本机已安装 `wrangler`（`npm install` 会自动装到 `node_modules`）

### 一、登录 Cloudflare

```bash
cd cloudflare
npm install
npx wrangler login
```

会弹出浏览器授权，点 **Allow** 即可。如果不想用浏览器，可以用 API Token：

```bash
# Dashboard → My Profile → API Tokens → Create Token → Edit Cloudflare Workers
set CLOUDFLARE_API_TOKEN=你的token      # Windows
export CLOUDFLARE_API_TOKEN=你的token    # macOS / Linux
```

### 二、创建 KV 命名空间

```bash
npx wrangler kv namespace create CONFIG
```

输出类似：

```
🌀 Creating namespace with title "mtv-source-converter-CONFIG"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "CONFIG"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

把那串 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]` 段，替换 `REPLACE_WITH_KV_NAMESPACE_ID`。

### 三、部署

```bash
npm run deploy
```

输出：

```
Total Upload: xx KiB / gzip: xx KiB
Uploaded mtv-source-converter (x.xx sec)
Published mtv-source-converter
  https://mtv-source-converter.<你的子域>.workers.dev
```

打开那个 URL 就是状态页。第一次访问 `/config.json` 会触发实时抓取（约 2–4 秒），之后全部走 KV，毫秒级返回。

### 四、（可选）开启手动刷新

```bash
npx wrangler secret put ADMIN_TOKEN
# 输入一串随机字符串
```

之后可以 `POST https://<worker>/refresh` 手动触发：

```bash
curl -X POST "https://<worker>/refresh?token=你的口令"
```

不设置则该端点返回 403，Cron 不受影响。

## 订阅地址

| 端点 | 内容 | 格式 |
|---|---|---|
| `GET /config.json` | 全部 73 站 | Base58 编码 JSON（MoonTVPlus `CONFIG_SUBSCRIPTION_URL` 用） |
| `GET /config-safe.json` | 屏蔽成人 58 站 | Base58 编码 JSON |
| `GET /config.txt` | 全部 73 站 | TVBox TXT |
| `GET /config-safe.txt` | 屏蔽成人 58 站 | TVBox TXT |
| `GET /` | 状态页 | HTML |
| `GET /health` | 健康检查 | JSON |
| `GET /stats` | 统计 + 全部源 | JSON |
| `POST /refresh` | 手动刷新（需 ADMIN_TOKEN） | JSON |

MoonTVPlus 里填：

```
CONFIG_SUBSCRIPTION_URL=https://mtv-source-converter.<你的子域>.workers.dev/config.json
```

或家庭场景用 `/config-safe.json`。

## 环境变量（`wrangler.toml` → `[vars]`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOURCE_URL` | `https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json` | 上游采集站清单 |
| `CACHE_TIME` | `7200` | 写入 MoonTVPlus 配置的 `cache_time` |
| `FETCH_TIMEOUT` | `30` | 抓取超时（秒） |
| `FETCH_RETRIES` | `3` | 抓取重试次数（指数退避 2s/4s/8s） |
| `STALE_IF_ERROR_HOURS` | `72` | 预留：上游失败时继续提供旧数据的最大时长 |

改完重新 `npm run deploy` 生效。敏感值用 `wrangler secret put`，不要写进 `[vars]`。

## Cron 调度

`wrangler.toml` 里：

```toml
[triggers]
crons = ["0 */2 * * *"]   # UTC 时间，每 2 小时整点
```

上游每 2 小时更新一次，这个频率刚好。要改频率就改 cron 表达式后重新部署。

本地调试 Cron：

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*/2+*+*+*"
```

## 本地开发

```bash
npm run dev          # 启动 http://localhost:8787，KV 用本地模拟
npm run check        # tsc --noEmit
npm run tail         # 看线上实时日志
```

## 文件结构

```
cloudflare/
├── src/
│   ├── index.ts        # 入口：路由 + Cron + 冷启动兜底 + 状态页
│   ├── converter.ts    # 采集站 → MoonTVPlus api_site / TVBox TXT（与 Python 版等价）
│   ├── fetcher.ts      # fetch + AbortController 超时 + 指数退避
│   ├── store.ts        # KV 读写（5 个 key）
│   └── base58.ts       # BigInt 实现，输出与 Python 版逐字节一致
├── wrangler.toml       # Workers 配置
├── tsconfig.json
├── package.json
└── .dev.vars.example   # 本地 secret 模板
```

## 常见问题

**Q：部署后 `/config.json` 返回 500 / `internal error`**
A：看 `npx wrangler tail`。多半是 KV namespace id 没填对，或者上游网络问题。

**Q：想换域名**
A：Dashboard → Workers → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain。

**Q：Cron 没跑**
A：Dashboard → Workers → Triggers → 确认 Cron Triggers 已显示 `0 */2 * * *`。手动触发一次验证：`curl "http://localhost:8787/__scheduled?cron=..."`（本地）或 `POST /refresh`（线上）。

**Q：和 Python 版输出不一样？**
A：不会。`converter.ts` 的过滤词表、`make_key` 去重逻辑、Base58 字母表都和 Python 版逐行对照过；`/stats` 里的 `total_sources` 可以直接和 Python 版 `python main.py --once` 的输出比对。
