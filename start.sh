#!/usr/bin/env bash
# =============================================================================
# 党政办信息跟踪与智能整理系统 — 主服务启动脚本
# 用法：
#   ./start.sh           # 前台启动
#   ./start.sh -d        # 后台启动（日志写入 /tmp/dzb-go.log）
#   ./start.sh stop      # 停止当前运行的服务
#   ./start.sh status    # 查看服务状态
# =============================================================================
set -e
cd "$(dirname "$0")"

GO_BIN="./.gotool/go/bin/go"
BIN="./dzbdemo"
LOG="/tmp/dzb-go.log"
PID_FILE="/tmp/dzb-go.pid"

# 加载环境变量
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
else
  echo "[warn] .env 文件不存在，使用默认配置（公众号订阅与 AI 模块将不可用）" >&2
fi

cmd="${1:-fg}"

case "$cmd" in
  stop)
    if [ -f "$PID_FILE" ]; then
      pid=$(cat "$PID_FILE")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && echo "[ok] 已停止 dzbdemo (pid=$pid)"
      else
        echo "[warn] pid 文件存在但进程不在，清理"
      fi
      rm -f "$PID_FILE"
    else
      # 兜底：按端口杀
      old=$(lsof -i:"${PORT:-8080}" -t 2>/dev/null | head -1 || true)
      if [ -n "$old" ]; then
        kill "$old" && echo "[ok] 已停止占用 :${PORT:-8080} 的进程 (pid=$old)"
      else
        echo "[info] 没有正在运行的服务"
      fi
    fi
    ;;

  status)
    echo "—— 主服务 ——"
    pid=$(lsof -i:"${PORT:-8080}" -t 2>/dev/null | head -1 || true)
    if [ -n "$pid" ]; then
      ps -p "$pid" -o pid,etime,command | tail -n +1
      curl -s -o /dev/null -w "  HTTP /api/auth/me -> %{http_code}\n" \
        "http://127.0.0.1:${PORT:-8080}/api/auth/me" || true
    else
      echo "  未运行"
    fi
    echo "—— wechat2rss (:${W2R_BASE##*:}) ——"
    curl -s -o /dev/null -w "  HTTP -> %{http_code}\n" "${W2R_BASE:-http://127.0.0.1:8090}/" || true
    echo "—— crawl4ai (:${CRAWLER_BASE##*:}) ——"
    curl -s -o /dev/null -w "  HTTP /health -> %{http_code}\n" "${CRAWLER_BASE:-http://127.0.0.1:8070}/health" || true
    ;;

  -d|daemon|background)
    # 先停旧
    "$0" stop >/dev/null 2>&1 || true
    sleep 1
    echo "[info] 编译二进制 -> $BIN"
    "$GO_BIN" build -o "$BIN" . || { echo "[err] 编译失败" >&2; exit 1; }
    echo "[info] 后台启动，日志: $LOG"
    nohup "$BIN" > "$LOG" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT:-8080}/" || echo 000)
    echo "[ok] dzbdemo pid=$(cat $PID_FILE)  HTTP -> $code"
    echo
    grep -E "\[(w2r|ai|crawler)\]" "$LOG" | tail -10 || true
    ;;

  fg|"")
    "$0" stop >/dev/null 2>&1 || true
    sleep 1
    echo "[info] 编译并前台启动 (Ctrl+C 退出)"
    echo "  W2R_BASE=$W2R_BASE"
    echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:0:10}…"
    echo
    "$GO_BIN" build -o "$BIN" . || exit 1
    exec "$BIN"
    ;;

  *)
    echo "用法: $0 [fg|-d|stop|status]" >&2
    exit 1
    ;;
esac
