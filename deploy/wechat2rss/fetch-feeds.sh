#!/usr/bin/env bash
# ============================================================================
# fetch-feeds.sh
# 从本机已部署的 wechat2rss 调用 /list 接口，列出当前已订阅的全部公众号
# 输出 JSON 到 stdout（每行一条），便于后续 jq / pipe 处理
#
# 用法：
#   ./fetch-feeds.sh                # 默认输出表格
#   ./fetch-feeds.sh --json         # 输出原始 JSON
#   ./fetch-feeds.sh --jsonl        # 一行一条 JSON（便于 jq -s ）
# ============================================================================
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ 没找到 .env"
  exit 1
fi
set -a; . ./.env; set +a

PORT=${HOST_PORT:-8080}
URL="http://127.0.0.1:${PORT}"

if [ -z "$RSS_TOKEN" ]; then
  echo "❌ .env 里没设置 RSS_TOKEN，无法调用 /list 接口"
  exit 1
fi

# 拉全量列表（一次 500 条，需要可改）
RAW=$(curl -sS --max-time 8 "${URL}/list?k=${RSS_TOKEN}&page=1&size=500" 2>&1)

# 校验返回是不是 JSON；不是的话给出有用错误信息
if [ -z "$RAW" ] || ! echo "$RAW" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "❌ /list 接口返回不是合法 JSON，可能原因："
  echo "    1) wechat2rss 还没启动 — 试 ./deploy.sh status"
  echo "    2) 服务尚未激活（LIC_EMAIL/LIC_CODE 不对）— 试 ./deploy.sh check"
  echo "    3) RSS_TOKEN 错 — 跟容器内的不一致"
  echo "    4) 端口 HOST_PORT (${PORT}) 不对"
  echo "—— 原始返回（前 500 字符）："
  echo "$RAW" | head -c 500
  echo
  exit 2
fi

mode=${1:-table}
case "$mode" in
  --json)
    echo "$RAW"
    ;;
  --jsonl)
    echo "$RAW" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data') or d.get('list') or d.get('items') or []
for it in items:
    print(json.dumps(it, ensure_ascii=False))"
    ;;
  *)
    echo "$RAW" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data') or d.get('list') or d.get('items') or []
total = d.get('meta',{}).get('total', len(items))
print(f'共 {total} 个已订阅公众号:')
print(f'  {\"ID\":<20}  {\"名字\":<28}  RSS feed')
for it in items:
    name = it.get('name') or it.get('id') or '-'
    link = it.get('link') or '-'
    iid  = str(it.get('id') or '-')
    print(f'  {iid:<20}  {name:<28}  {link}')"
    ;;
esac
