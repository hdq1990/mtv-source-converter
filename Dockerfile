FROM python:3.12-slim

LABEL maintainer="MTV Source Converter"
LABEL description="定时从 ziyuanzu.com 抓取采集站清单，转换为 MoonTVPlus 配置，提供 HTTP 订阅地址"

WORKDIR /app

# 日志即时刷出（不加这个，docker logs 在非 tty 环境下会整段缓冲，看不到抓取进度）
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 只复制运行需要的文件，避免把 __pycache__ / README 之类打进镜像
COPY main.py fetcher.py converter.py server.py config.py ./

# 以非 root 运行；/app/data 用来存探测状态（跨重启保留「连续失败几次」的累积）
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app
USER appuser

# 暴露 HTTP 订阅端口
EXPOSE 8080

# 健康检查：每 5 分钟检查一次 /health 端点
HEALTHCHECK --interval=5m --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)" || exit 1

# 启动主程序
CMD ["python", "main.py"]
