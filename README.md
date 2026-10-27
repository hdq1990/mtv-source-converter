# 🎬 MTV Source Converter

定时从 [ziyuanzu.com](https://www.ziyuanzu.com) 抓取影视采集站清单，转换为 [MoonTVPlus](https://github.com/mtvpls/MoonTVPlus) 可用的 `api_site` 配置，通过 HTTP 提供订阅地址。

## ✨ 功能特性

- ⏰ **定时抓取** — 默认每 2 小时从 ziyuanzu.com 拉取最新采集站清单
- 🔄 **自动转换** — 苹果 CMS V10 接口直接转换为 MoonTVPlus `api_site` 格式
- 📡 **双版本订阅** — 提供全部站点（73个）和屏蔽成人版（58个）两个订阅地址
- 🐳 **Docker 运行** — Python 标准库实现，镜像仅 ~50MB
- 🌐 **Cloudflare Workers** — TypeScript 实现，全球边缘网络，免费部署
- 📊 **状态页面** — 内置 Web 面板查看采集站数量、抓取次数、最后更新时间
- 🔁 **自动重试** — 抓取失败时指数退避重试，服务不中断
- 🏗️ **CI/CD 构建** — GitHub Actions 自动构建推送 Docker 镜像到 GHCR

## 📋 工作原理

```
ziyuanzu.com (每2h更新)  →  HTTP 抓取  →  转换为 MoonTVPlus api_site
                                    ↓
                        HTTP 订阅服务 (:8080)
                                    ↓
                         MoonTVPlus CONFIG_SUBSCRIPTION_URL
```

1. 从 `https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json` 下载采集站清单
2. 该文件由网站 CI/CD 每 2 小时自动更新，仅收录可用率 ≥ 95% 的站点
3. 将每个采集站的苹果 CMS V10 API 地址转换为 MoonTVPlus 的 `api_site` 条目
4. 通过 HTTP 服务暴露配置，MoonTVPlus 通过订阅地址拉取

## 🚀 快速开始

### 方案 A：Cloudflare Workers（推荐公开订阅）

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler kv namespace create CONFIG
# 将 KV Namespace ID 填入 wrangler.toml
npm run dev    # 本地测试
npm run deploy # 部署到 Cloudflare
```

部署后访问 `https://<worker>.workers.dev/`，详细指南见 [cloudflare/README.md](cloudflare/README.md)。

### 方案 C：Docker Compose 部署（推荐内网自用）

```bash
git clone https://github.com/<your-username>/mtv-source-converter.git
cd mtv-source-converter
docker compose up -d --build
```

### 方案 C：直接运行

```bash
python main.py
```

### 方案 C：调试模式（单次抓取）

```bash
python main.py --once
```

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `SOURCE_URL` | `https://www.ziyuanzu.com/download/ziyuanzu-cms-interfaces.json` | 采集站 JSON 下载地址 |
| `FETCH_INTERVAL` | `7200` | 定时抓取间隔（秒） |
| `HTTP_PORT` | `8080` | HTTP 服务监听端口 |
| `CACHE_TIME` | `7200` | MoonTVPlus 配置中的 cache_time（秒） |
| `FETCH_TIMEOUT` | `30` | 抓取请求超时（秒） |

## 📡 API 端点

| 端点 | 说明 |
|------|------|
| `GET /config.json` | **全部站点订阅** — 73 个采集站（不过滤） |
| `GET /config-safe.json` | **屏蔽成人版订阅** — 58 个采集站（过滤成人内容） |
| `GET /config.txt` | TVBox 风格 TXT（全部站点） |
| `GET /config-safe.txt` | TVBox 风格 TXT（屏蔽成人版） |
| `GET /` | Web 状态面板 |
| `GET /health` | 健康检查 |
| `GET /stats` | 统计信息 + 全部源列表 |

### 两个订阅版本

| 版本 | 订阅地址 | 站点数 | 适用场景 |
|------|---------|--------|---------|
| 📦 全部站点 | `http://<IP>:8080/config.json` | 73 | 完整资源覆盖 |
| 🛡️ 屏蔽成人版 | `http://<IP>:8080/config-safe.json` | 58 | 家庭/公开场景 |

屏蔽版会过滤名称或域名中包含成人关键词的采集站（湿乐园、番号、麻豆、黑料、色猫等）。

## 🔗 与 MoonTVPlus 配合使用

在 MoonTVPlus 的 `docker-compose.yml` 中添加环境变量：

```yaml
services:
  moontv-core:
    image: ghcr.io/mtvpls/moontvplus:latest
    environment:
      # ... 其他配置 ...
      CONFIG_SUBSCRIPTION_URL: http://mtv-source-converter:8080/config.json
```

或在 MoonTVPlus 管理面板 → 配置管理 → 订阅地址中直接填入：

```
http://<服务器IP>:8080/config.json
```

## 🏗️ GitHub Actions 自动构建

推送代码到 `main` 分支后，GitHub Actions 自动构建并推送 Docker 镜像到 GHCR：

```bash
docker pull ghcr.io/<your-username>/mtv-source-converter:latest
```

## 📁 项目结构

```
mtv-source-converter/
├── # 方案 C：Docker 部署（Python）
├── main.py              # 主程序入口（定时调度 + HTTP 服务）
├── fetcher.py           # 抓取模块（urllib 标准库）
├── converter.py         # 转换模块（采集站 → MoonTVPlus api_site）
├── server.py            # HTTP 订阅服务
├── config.py            # 配置常量（环境变量）
├── Dockerfile           # Docker 镜像构建
├── docker-compose.yml   # Docker Compose 部署
├── .github/workflows/
│   └── docker-build.yml # GitHub Actions 自动构建推送
│
├── # 方案 A：Cloudflare Workers 部署（TypeScript）
├── cloudflare/
│   ├── src/
│   │   ├── index.ts     # Workers 入口（fetch + scheduled）
│   │   ├── config.ts    # 配置常量
│   │   ├── fetcher.ts   # 抓取模块（fetch API）
│   │   ├── converter.ts # 转换模块（采集站 → MoonTVPlus api_site）
│   │   └── store.ts     # KV 存储模块
│   ├── wrangler.toml    # Workers 配置（KV + Cron）
│   ├── package.json     # npm 依赖
│   ├── tsconfig.json    # TypeScript 配置
│   └── README.md        # Workers 部署指南
│
└── README.md
```

## 📦 技术栈

### 方案 C：Docker 部署（Python）

- **Python 3.12** — 纯标准库，零第三方 pip 依赖
- **http.server** — 内置 HTTP 服务，无需 Flask/FastAPI
- **urllib.request** — HTTP 抓取，无需 requests
- **Docker** — 轻量容器化部署

### 方案 A：Cloudflare Workers 部署（TypeScript）

- **TypeScript** — 类型安全，编译到 JavaScript
- **Cloudflare Workers** — 边缘计算，全球低延迟
- **KV Storage** — 持久化存储配置数据
- **Cron Triggers** — 定时抓取任务
- **fetch API** — 原生 HTTP 请求

## 📄 License

[MIT](LICENSE)
