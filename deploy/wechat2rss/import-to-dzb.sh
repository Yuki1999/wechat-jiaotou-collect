#!/usr/bin/env bash
# ============================================================================
# import-to-dzb.sh
# 把 wechat2rss 上已订阅的全部公众号一键导入"党政办信息跟踪与智能整理系统"
# 调用本系统 /api/sources/bulk_import；已存在的 URL 自动跳过。
#
# 用法：
#   ./import-to-dzb.sh                              # 默认全部 → 默认分组
#   ./import-to-dzb.sh --filter 苏州                # 仅导入名称含"苏州"的
#   ./import-to-dzb.sh --group 招商组 --owner 王干事
#   ./import-to-dzb.sh --category 企业类
#   ./import-to-dzb.sh --dry-run                    # 不真正导入，只显示要导入啥
# ============================================================================
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then echo "❌ 没找到 .env"; exit 1; fi
set -a; . ./.env; set +a

PORT=${HOST_PORT:-8080}
W2R="http://127.0.0.1:${PORT}"
DZB=${DZB_BASE:-http://127.0.0.1:8080}

if [ -z "$RSS_TOKEN" ]; then echo "❌ 缺 RSS_TOKEN"; exit 1; fi

# 解析参数
FILTER=""; GROUP="综合组"; OWNER="王干事"; CATEGORY="企业类"; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --filter)    FILTER="$2"; shift 2;;
    --group)     GROUP="$2"; shift 2;;
    --owner)     OWNER="$2"; shift 2;;
    --category)  CATEGORY="$2"; shift 2;;
    --dry-run)   DRY=1; shift;;
    *) echo "未知参数: $1"; exit 1;;
  esac
done

# 1) 从 wechat2rss 拉清单
echo "[1/3] 从 wechat2rss 拉取公众号清单…"
RAW=$(curl -sS --max-time 8 "${W2R}/list?k=${RSS_TOKEN}&page=1&size=500" 2>&1)
if [ -z "$RAW" ] || ! echo "$RAW" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "❌ wechat2rss /list 返回非 JSON，请先用 ./fetch-feeds.sh 自检"
  echo "—— 原始返回（前 300 字符）："
  echo "$RAW" | head -c 300
  echo
  exit 2
fi

# 2) 转成本系统的 source 数组（用 python 拼）
echo "[2/3] 转成党政办系统的 source 格式（filter='${FILTER}'）…"
PAYLOAD=$(echo "$RAW" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data') or d.get('list') or d.get('items') or []
flt = '''$FILTER'''.strip()
out = []
for it in items:
    name = it.get('name') or str(it.get('id') or '')
    link = it.get('link') or ''
    if not link: continue
    if flt and flt not in name: continue
    out.append({
        'unit': name + ' [公众号]',
        'type': 'wechat2rss',
        'kind': 'rss',
        'category': '$CATEGORY',
        'url': link,
        'owner_name': '$OWNER',
        'group': '$GROUP',
        'frequency': 'daily',
    })
print(json.dumps({'items': out}, ensure_ascii=False))")

COUNT=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))")
echo "    → 待导入 $COUNT 条"

if [ "$COUNT" = "0" ]; then
  echo "没有匹配的公众号，停止。"
  exit 0
fi

echo "$PAYLOAD" | python3 -c "
import json, sys
for it in json.load(sys.stdin)['items'][:10]:
    print(f\"    · {it['unit'][:40]:40}  {it['url'][:60]}\")"
[ "$COUNT" -gt 10 ] && echo "    （仅显示前 10 条）"

if [ "$DRY" = "1" ]; then
  echo "[dry-run] 实际未推送到党政办系统。"
  exit 0
fi

# 3) 推送
echo "[3/3] 推送到党政办系统 ${DZB}/api/sources/bulk_import …"
RES=$(curl -sS -X POST -H 'Content-Type: application/json' \
  --max-time 10 \
  -d "$PAYLOAD" \
  "${DZB}/api/sources/bulk_import")
echo "$RES" | python3 -m json.tool 2>/dev/null || echo "$RES"

echo "✓ 完成。打开党政办系统的「信息源管理」页面就能看到新增的源。"
echo "  下一步：在该页点 ▶ 全量采集，立即拉取真实公众号文章。"
