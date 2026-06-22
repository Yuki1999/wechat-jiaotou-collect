#!/usr/bin/env bash
# ============================================================================
# wechat2rss 部署 / 升级 / 状态查看一键脚本
# 用法：
#   ./deploy.sh up         首次/常规启动
#   ./deploy.sh down       停止并保留数据
#   ./deploy.sh restart    重启
#   ./deploy.sh logs       看日志（按 Ctrl+C 退出）
#   ./deploy.sh status     看状态（端口/容器/feed 总数）
#   ./deploy.sh upgrade    拉新镜像后重启（数据保留）
#   ./deploy.sh backup     备份数据卷到 backups/yyyymmdd-HHMM.tgz
#   ./deploy.sh check      检查激活 / 健康
# ============================================================================
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ 没找到 .env，请先 cp .env.example .env 并填好三项激活信息"
  exit 1
fi

# 加载 .env 供脚本本身使用（compose 自己也会读）
set -a
. ./.env
set +a

DC() { docker compose "$@"; }

CMD=${1:-up}
case "$CMD" in
  up)
    mkdir -p data logs
    DC up -d
    sleep 2
    DC ps
    echo
    echo "✓ 服务已启动。访问 http://${RSS_HOST}  (Token: ${RSS_TOKEN})"
    echo "  · 在控制台粘贴公众号文章链接订阅"
    echo "  · 之后可调用 ./fetch-feeds.sh 把 feed 同步到党政办系统"
    ;;
  down)
    DC down
    ;;
  restart)
    DC restart
    ;;
  logs)
    DC logs -f --tail 200
    ;;
  status)
    echo "== 容器 =="
    DC ps
    echo
    echo "== 端口监听 =="
    (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":${HOST_PORT:-8080} " || echo "  端口未监听"
    echo
    echo "== 健康 =="
    curl -sS --max-time 3 "http://127.0.0.1:${HOST_PORT:-8080}/version" \
      && echo || echo "  /version 不可达"
    echo
    echo "== 已订阅公众号数 =="
    if [ -n "$RSS_TOKEN" ]; then
      LIST=$(curl -sS --max-time 5 "http://127.0.0.1:${HOST_PORT:-8080}/list?k=${RSS_TOKEN}" || true)
      echo "$LIST" | grep -oE '"total":[0-9]+' | head -1 || echo "  无 (或鉴权失败)"
    else
      echo "  未设置 RSS_TOKEN，跳过"
    fi
    ;;
  upgrade)
    DC pull
    DC up -d
    DC ps
    ;;
  backup)
    mkdir -p backups
    f="backups/$(date +%Y%m%d-%H%M).tgz"
    tar czf "$f" data
    echo "✓ 备份完成: $f  ($(du -h $f | cut -f1))"
    ;;
  check)
    echo "== 容器是否运行 =="
    docker ps --filter name=wechat2rss --format "{{.Names}}\t{{.Status}}"
    echo
    echo "== /version =="
    curl -sS "http://127.0.0.1:${HOST_PORT:-8080}/version" && echo
    echo
    echo "== 激活状态（搜日志中 LIC） =="
    docker logs wechat2rss 2>&1 | grep -iE "license|lic_|auth|expir" | tail -5 || echo "  (无相关日志)"
    ;;
  *)
    echo "用法：$0 {up|down|restart|logs|status|upgrade|backup|check}"
    exit 1
    ;;
esac
