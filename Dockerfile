FROM python:3.12-slim

LABEL maintainer="MTV Source Converter"
LABEL description="定时从 ziyuanzu.com 抓取采集站清单，转换为 MoonTVPlus 配置，提供 HTTP 订阅地址"

WORKDIR /app

# 复制项目代码
COPY . .

# 暴露 HTTP 订阅端口
EXPOSE 8080

# 健康检查：每 5 分钟检查一次 /health 端点
HEALTHCHECK --interval=5m --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health', timeout=3)" || exit 1

# 启动主程序
CMD ["python", "main.py"]
