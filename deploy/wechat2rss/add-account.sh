#!/usr/bin/env bash
# ============================================================================
# add-account.sh
# 通过 wechat2rss API 用一条微信公众号文章链接快速添加订阅
# 用法：
#   ./add-account.sh "https://mp.weixin.qq.com/s/xxxxx"
#   ./add-account.sh "https://mp.weixin.qq.com/s/xxxxx" "https://mp.weixin..." ...
# ============================================================================
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then echo "❌ 没找到 .env"; exit 1; fi
set -a; . ./.env; set +a
PORT=${HOST_PORT:-8080}
[ -z "$RSS_TOKEN" ] && { echo "❌ 缺 RSS_TOKEN"; exit 1; }
[ $# -eq 0 ] && { echo "用法：$0 <公众号文章URL> [更多URL...]"; exit 1; }

for url in "$@"; do
  echo "→ 添加: $url"
  R=$(curl -sS --max-time 12 \
    "http://127.0.0.1:${PORT}/addurl?url=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$url")&k=${RSS_TOKEN}")
  echo "  返回: $R"
  echo
done
echo "✓ 完成。可以运行 ./fetch-feeds.sh 查看；或 ./import-to-dzb.sh 导入党政办系统。"
