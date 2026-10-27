# 🌐 Cloudflare Workers 部署指南

定时从 ziyuanzu.com 抓取采集站清单，转换为 MoonTVPlus 配置，通过 HTTP 提供订阅地址。

## 📦 前置条件

1. [Node.js](https://nodejs.org/) ≥ 18
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install/)
3. Cloudflare 账号（免费）

## 🚀 部署步骤

### 1. 安装依赖

```bash
cd cloudflare
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 KV Namespace

在 Cloudflare 控制台 → Workers & Pages → KV → 创建 Namespace，名称设为 `CONFIG`，记下 Namespace ID。

### 4. 配置 wrangler.toml

将 `wrangler.toml` 中的 `id` 替换为你的 KV Namespace ID：

```toml
[kv_namespaces]
binding = "KV"
id = "你的KV Namespace ID"
```

### 5. 本地测试

```bash
npm run dev
```

访问 `http://localhost:8787/` 查看服务信息页。

### 6. 部署到 Cloudflare

```bash
npm run deploy
```

部署后访问 `https://<your-worker-name>.workers.dev/` 即可。

## 📡 订阅地址

| 版本 | 订阅地址 | 站点数 |
|------|---------|--------|
| 📦 全部站点 | `https://<worker>.workers.dev/config.json` | 73 |
| 🛡️ 屏蔽成人版 | `https://<worker>.workers.dev/config-safe.json` | 58 |

## 🔧 定时抓取

在 `wrangler.toml` 中配置 Cron 触发器：

```toml
[triggers]
cron = ["0 */2 * * *"]  # 每 2 小时抓取一次
```

也可以手动触发抓取：

```bash
curl -X POST https://<worker>.workers.dev/fetch
```

## 📊 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 服务信息页 |
| `/config.json` | GET | 全部站点配置 |
| `/config-safe.json` | GET | 屏蔽成人版配置 |
| `/config.txt` | GET | TVBox 全部格式 |
| `/config-safe.txt` | GET | TVBox 屏蔽版格式 |
| `/health` | GET | 健康检查 |
| `/stats` | GET | 统计信息 |
| `/fetch` | POST | 手动触发抓取 |

## 💰 费用

- **Workers**: 免费计划每天 10 万次请求
- **KV**: 免费计划每天 10 万次读 + 1000 次写
- **Cron**: 免费

对于本项目的使用量（每 2 小时抓取一次 + 偶尔的订阅请求），完全在免费额度内。

## 🔄 与 MoonTVPlus 配合

在 MoonTVPlus 的 `docker-compose.yml` 中配置订阅地址：

```yaml
services:
  moontv-core:
    environment:
      CONFIG_SUBSCRIPTION_URL: https://<worker>.workers.dev/config.json
```

或在 MoonTVPlus 管理面板 → 配置管理 → 订阅地址中直接填入订阅地址。
