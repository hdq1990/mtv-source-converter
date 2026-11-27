# MTV Source Converter — Cloudflare Workers 版

零服务器、免费套餐即可运行的 MoonTVPlus 配置订阅服务。抓取逻辑、转换规则、过滤词表、输出字节流与 Python 版 **1:1 对齐**。

## 架构

```
Cron :00 （每 2h）──► fetch ziyuanzu.com ──► 转换 ──► Base58（全部版）
                                                    └─► KV：5 个 key
Cron :02 （每 2h）──► 读 KV 里的屏蔽版明文 ──► Base58 ──► KV：+1 个 key
                                                              │
GET /config.json ─────────────────────────────────────────────┴──► 直接读 KV 返回（CPU < 1 ms）
GET /config.json（KV 为空）──► 请求内实时抓取 + 只编码这一份（冷启动兜底）
```

| 组件 | 作用 | 免费额度 |
|---|---|---|
| Workers | 路由 + 抓取 + 转换 + 编码 | 10 万请求/天，**10 ms CPU/次** |
| KV | 6 份产物 + 1 份元数据 | 10 万读 / 1000 写 每天 |
| Cron Triggers | 定时触发（两个表达式） | 免费，5 个/账号 |
| Observability | 日志 | 免费 20 万事件/天 |

订阅场景每天几十次请求，请求数和 KV 读额度绰绰有余。真正需要留意的是 **CPU 时间**，见下一节。

## ⚠️ 关于 CPU 时间：为什么编码放在 Cron 里

`bs58` 这类进制转换本质是 O(n²)。实测（本机 Node 22 / V8，7.9 KB 输入 → 10.8 K 字符）：

| 实现 | 耗时 |
|---|---|
| naive BigInt（每位除 58） | 397 ms |
| BigInt 分块 58^9 | 60 ms |
| BigInt 分块 58^64 | 32 ms |
| **BigInt 分块 58^512 + 8 位组拆解（本项目用的）** | **22 ms** |
| 手写 Uint32Array limb 除法 | 77 ms |
| 经典逐字节 Number 算法 | 367 ms |

真实数据（6269 B → 8562 字符）大约 **14 ms/份**。而 Workers **免费套餐的 CPU 预算是每次调用 10 ms**（HTTP 请求和 Cron Trigger 都一样），超了会返回 `error 1102 / Worker exceeded resource limits`。

所以本项目做了三件事：

1. **Base58 只在数据更新时算**，请求路径只读 KV 里的字符串 → 订阅接口 CPU < 1 ms。
2. **Cron 拆成两跳**：`:00` 编「全部版」，`:02` 编「屏蔽版」，单次调用只编一份。
3. **冷启动只编被请求的那一份**，不会一次把两份都算了。

即便如此，`:00` 那次仍然会跑 14 ms 左右，**技术上超出免费套餐 10 ms 预算**。Cloudflare 对「偶尔小幅超出」有内置容错（官方文档原话：*Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit*），Cron 每 2 小时才跑一次，落在容错范围内的概率很高。

**实测结论（2026-11 在免费账号上跑通）**：冷启动 `/config.json`（抓取 + 转换 + 1 份 Base58）、`/config-safe.json`（第 2 份 Base58）、以及手动 `POST /refresh`（一次编 2 份 ≈ 28 ms）**全部返回 200，没有出现 `exceededCpu`**。也就是说这个预算余量在真实免费套餐上是够用的 —— 但仍然不是硬保证，如果以后数据量翻倍或 Cloudflare 调整策略，还是会撞上。

如果 `wrangler tail` 或 Dashboard → Metrics → Errors 里出现 `exceededCpu`，按优先级选一个：

| 方案 | 成本 | 说明 |
|---|---|---|
| **A. 用 Python/Docker 版做订阅源** | 免费 | 仓库根目录的方案 B，CPU 不受限，`/config.json` 输出与 Workers 版逐字节一致 |
| **B. 升级 Workers Paid** | $5/月 | CPU 预算从 10 ms 提到 30 s，在 `wrangler.toml` 加 `[limits] cpu_ms = 30000` 即可 |
| **C. GitHub Actions 定时写 KV** | 免费 | 用 Python 算好 Base58，再通过 CF API 写进 KV；Worker 完全不编码。片段见下文 |

### 方案 C：GitHub Actions 预热 KV

在仓库里新建 `.github/workflows/update-kv.yml`（**需要自己手动建**，因为默认的 PAT 没有 `workflow` 权限）：

```yaml
name: update-kv
on:
  schedule: [{ cron: "0 */2 * * *" }]
  workflow_dispatch:
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: gen
        run: |
          python3 - <<'PY' > payload.txt
          import json, urllib.request, sys
          sys.path.insert(0, '.')
          from converter import convert_to_moontvplus
          from server import base58_encode
          raw = urllib.request.urlopen(
              'https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json', timeout=30).read()
          sites = json.loads(raw)
          cfg = convert_to_moontvplus(sites, cache_time=7200, filter_adult=False)
          print(base58_encode(json.dumps(cfg, ensure_ascii=False, separators=(',', ':')).encode()))
          PY
      - env:
          CF_TOKEN: ${{ secrets.CF_API_TOKEN }}
          ACCOUNT: ${{ secrets.CF_ACCOUNT_ID }}
          NS: ${{ secrets.CF_KV_NAMESPACE_ID }}
        run: |
          curl -sS -X PUT \
            "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/storage/kv/namespaces/$NS/values/config_full_b58" \
            -H "Authorization: Bearer $CF_TOKEN" \
            --data-binary @payload.txt
```

`CF_API_TOKEN` 需要 `Workers KV Storage:Edit` 权限。设好之后把 `wrangler.toml` 里的 cron 清空（`crons = []`），Worker 就彻底不编码了。

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
Total Upload: 42.90 KiB / gzip: 11.98 KiB
Uploaded mtv-source-converter (x.xx sec)
Deployed mtv-source-converter triggers (x.xx sec)
  https://mtv-source-converter.<你的子域>.workers.dev
  schedule: 0 */2 * * *
  schedule: 2 */2 * * *
```

> 首次部署后建议手动预热一次，别等 2 小时后第一次 Cron：
> ```bash
> npx wrangler secret put ADMIN_TOKEN     # 设一个口令
> curl -X POST -H "X-Admin-Token: 你的口令" https://<你的域名>/refresh
> ```

### 四、⚠️ 中国大陆必须绑自定义域名

**`*.workers.dev` 在国内不可用**：DNS 被污染（返回 `face:b00c` 这类假 IP），而且即使手动拿真实 Cloudflare IP 直连，TLS 握手也会被 RST。这不是本项目的问题，是域名本身被阻断。

唯一的解决办法是绑一个 NS 已托管到 Cloudflare 的自有域名。在 `wrangler.toml` 里加：

```toml
routes = [
  { pattern = "mtv.your-domain.com", custom_domain = true }
]
```

再 `npm run deploy`，wrangler 会自动创建 DNS 记录并签发证书（Custom Domain 模式，几秒到几分钟生效）。之后用 `https://mtv.your-domain.com/config.json` 做订阅地址。

验证：`curl -sS https://mtv.your-domain.com/health`，能返回 JSON 就说明通了。

### 五、（可选）开启手动刷新

```bash
npx wrangler secret put ADMIN_TOKEN
```

之后可以这样触发（**推荐用 header，token 不会进访问日志**）：

```bash
curl -X POST -H "X-Admin-Token: 你的口令" https://<你的域名>/refresh
```

`?token=xxx` 查询参数也支持，但会留在 Cloudflare 的请求日志里，能用 header 就别用 query。不设置 `ADMIN_TOKEN` 则该端点返回 403，Cron 不受影响。

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
| `POST /refresh` | 手动刷新（需 `ADMIN_TOKEN`） | JSON |

MoonTVPlus 里填（国内请用自定义域名，`workers.dev` 不通）：

```
CONFIG_SUBSCRIPTION_URL=https://mtv.your-domain.com/config.json
```

家庭场景用 `/config-safe.json`。

### 状态码约定

| 情况 | 响应 |
|---|---|
| 正常 | `200` + 内容 |
| KV 里还没有数据、上游也抓不到 | `503` + `Retry-After: 60` |
| 刚失败过（60 秒冷却内） | `503`，detail 里带上一次的错误，**不会重复打上游** |
| `/refresh` 没配 `ADMIN_TOKEN` | `403` |
| `/refresh` token 不对 | `401` |
| `/refresh` 用 GET | `405`（只接受 POST） |
| 其他方法 / 未知路径 | `405` / `404` |

## 环境变量（`wrangler.toml` → `[vars]`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOURCE_URL` | `https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json` | 上游采集站清单 |
| `CACHE_TIME` | `7200` | 写入 MoonTVPlus 配置的 `cache_time` |
| `FETCH_TIMEOUT` | `30` | 抓取超时（秒） |
| `FETCH_RETRIES` | `3` | 抓取重试次数（指数退避 2s/4s/8s；4xx、非 JSON、空数组直接放弃，不浪费退避时间） |
| `STALE_IF_ERROR_HOURS` | `72` | 数据超过这么多小时没更新，`/health` 的 `status` 变成 `stale` |

改完重新 `npm run deploy` 生效。敏感值用 `wrangler secret put`，不要写进 `[vars]`。

## Cron 调度

```toml
[triggers]
crons = ["0 */2 * * *", "2 */2 * * *"]   # UTC，每 2 小时的 :00 和 :02
```

- `:00` 抓上游 + 转换 + 编码「全部版」+ 写 KV
- `:02` 从 KV 读「屏蔽版」明文，只补 Base58 编码

上游每 2 小时更新一次，这个频率刚好。

本地调试 Cron：

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*/2+*+*+*"   # 走 :00 那条
curl "http://localhost:8787/__scheduled?cron=2+*/2+*+*+*"   # 走 :02 那条
```

## 本地开发

```bash
npm run dev          # 启动 http://localhost:8787，KV 用本地模拟
npm run check        # tsc --noEmit
npm run tail         # 看线上实时日志（排障首选，CPU 时间也在里面）
```

## 文件结构

```
cloudflare/
├── src/
│   ├── index.ts        # 入口：路由 + Cron 两跳 + 冷启动兜底 + 状态页
│   ├── converter.ts    # 采集站 → MoonTVPlus api_site / TVBox TXT（与 Python 版等价）
│   ├── fetcher.ts      # fetch + AbortController 超时 + 指数退避 + 错误分类
│   ├── store.ts        # KV 读写（7 个 key，按需单 key 读）
│   └── base58.ts       # Base58 编码（分块 BigInt，输出与 Python 版逐字节一致）
├── wrangler.toml       # Workers 配置
├── tsconfig.json
├── package.json
└── .dev.vars.example   # 本地 secret 模板
```

## 常见问题

**Q：部署后 `/config.json` 返回 503**
A：`detail` 字段会写原因。三种常见情况：① 第一次访问还在抓（等 2–4 秒再刷）；② 上游挂了（看 `last_error`）；③ 60 秒冷却中（刚失败过，等它过去）。

**Q：`wrangler tail` 里看到 `exceededCpu` / `Worker exceeded resource limits`**
A：见上面「关于 CPU 时间」那一节，这是 Base58 编码超出免费套餐 10 ms 预算导致的。选 A/B/C 任一方案。

**Q：想换域名**
A：Dashboard → Workers → 你的 Worker → Settings → Domains & Routes → Add → Custom Domain。

**Q：Cron 没跑**
A：Dashboard → Workers → Triggers → 确认两个 Cron 表达式都在。本地可以用 `__scheduled` 手测，线上用 `POST /refresh` 手测。

**Q：和 Python 版输出不一样？**
A：不会，两边的字节流是逐字节一致的（`6269 B → 8562 字符`、`4992 B → 6818 字符`），转换词表、`makeKey` 去重逻辑、JSON 序列化格式（紧凑、无空格）、Base58 字母表全部对齐过。

**Q：KV 里的 key 都是什么？**
A：`config_full` / `config_safe`（明文 JSON，供 `/stats` 和调试）、`config_full_b58` / `config_safe_b58`（订阅直出）、`tvbox_full` / `tvbox_safe`（TXT）、`meta`（站点数、成功/失败次数、最后更新、最后错误）。
