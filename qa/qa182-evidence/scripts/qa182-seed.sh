#!/bin/bash
# QA #176 造数脚本（真跑用，只调 API，不改被测代码）
# 用法: ./seed.sh <port> <tag>
# 产出: 每实例 1 管理员(jim) + 1 空间 + 1 页面(段落/宽表格/长代码行) + 1 顶层评论 + 1 条回复
set -e
PORT=${1:-8905}
TAG=${2:-base}
BASE=http://127.0.0.1:$PORT
OUT=/tmp/qa176/out-$TAG
mkdir -p $OUT

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

echo "=== 1. 初始化（迁移）X-Setup-Secret ==="
SETUP_SECRET=$(cat /tmp/qa176/setup-$TAG.txt)
curl -s -X POST $BASE/api/setup -H "X-Setup-Secret: $SETUP_SECRET" -H 'Content-Type: application/json' -d '{"language":"zh"}' | head -c 300
echo

echo "=== 2. 注册第一个用户 jim（=站点管理员）==="
curl -s -X POST $BASE/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"jim@example.com","password":"JimPass123!","language":"zh"}' | head -c 200
echo
curl -s -c $OUT/jim.jar -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"jim@example.com","password":"JimPass123!"}' | head -c 200
echo
JIM_ID=$(curl -s -b $OUT/jim.jar $BASE/api/me | jqget "['id']")
echo "JIM_ID=$JIM_ID"

echo "=== 3. 建空间 ==="
SPACE=$(curl -s -b $OUT/jim.jar -X POST $BASE/api/spaces -H 'Content-Type: application/json' \
  -d '{"name":"验收空间","description":"#176 聚焦环验收用"}')
echo "$SPACE" > $OUT/space.json
SPACE_ID=$(jqget "['id']" < $OUT/space.json)
echo "SPACE_ID=$SPACE_ID"

echo "=== 3.5 创建读写令牌（/api/write/pages 只认 Bearer 令牌，不认会话）==="
TOKEN_JSON=$(curl -s -b $OUT/jim.jar -X POST $BASE/api/me/tokens -H 'Content-Type: application/json' \
  -d '{"kind":"write","name":"qa176-seed"}')
echo "$TOKEN_JSON" > $OUT/token.json
WRITE_TOKEN=$(jqget "['token']" < $OUT/token.json)
echo "WRITE_TOKEN len=${#WRITE_TOKEN}"

echo "=== 4. 建页面（正文：段落×2 + 宽表格 + 长代码行）==="
python3 - "$SPACE_ID" > $OUT/page-payload.json <<'PYEOF'
import json, sys
space_id = int(sys.argv[1])
LONG = "超宽表格列的单元格文本故意写得很长以撑破列宽造成横向溢出场景" * 3
COLS = ["列一标题", "列二标题", "列三标题", "列四标题", "列五标题", "列六标题", "列七标题", "列八标题"]
header = {"type": "tableRow", "content": [
    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": c}]}]}
    for c in COLS
]}
row = {"type": "tableRow", "content": [
    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": LONG}]}]}
    for _ in COLS
]}
code = ("const focusRing = \"聚焦环溢出验证用超长代码行，单词不断行直接撑破容器宽度造成横向滚动场景\" + \"x\" * 1; // " + "a" * 200)
doc = {
    "type": "doc",
    "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "这是评论输入框聚焦环验收页面的正文第一段：验证发表框、行内回复框、编辑框聚焦时聚焦环左右完整无截断，并核对输入框与正文列的对齐关系。"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "第二段：页面下方有超宽表格与长代码行，用于验证横向滚动仍被阻截在各自容器内。"}]},
        {"type": "codeBlock", "attrs": {"language": "js"}, "content": [{"type": "text", "text": code}]},
        {"type": "table", "content": [header, row]},
    ],
}
json.dump({"space_id": space_id, "title": "聚焦环验收页", "content_json": doc}, sys.stdout, ensure_ascii=False)
PYEOF
PAGE=$(curl -s -X POST $BASE/api/write/pages -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' --data-binary @$OUT/page-payload.json)
echo "$PAGE" > $OUT/page.json
PAGE_ID=$(jqget "['id']" < $OUT/page.json)
echo "PAGE_ID=$PAGE_ID"

echo "=== 5. 发顶层评论 ==="
C1=$(curl -s -b $OUT/jim.jar -X POST $BASE/api/pages/$PAGE_ID/comments -H 'Content-Type: application/json' \
  -d '{"bodyMd":"这是顶层评论：点击本评论下的「回复」验证行内回复框，点「编辑」验证编辑框。"}')
echo "$C1" > $OUT/comment1.json
C1_ID=$(jqget "['id']" < $OUT/comment1.json)
echo "C1_ID=$C1_ID"

echo "=== 6. 发一条回复（让会话列表出现嵌套回复）==="
C2=$(curl -s -b $OUT/jim.jar -X POST $BASE/api/pages/$PAGE_ID/comments -H 'Content-Type: application/json' \
  -d "{\"bodyMd\":\"这是一条嵌套回复。\",\"parentId\":$C1_ID}")
echo "$C2" > $OUT/comment2.json
echo "C2_ID=$(jqget "['id']" < $OUT/comment2.json)"

echo "=== 造数完成: PORT=$PORT TAG=$TAG JIM_ID=$JIM_ID SPACE_ID=$SPACE_ID PAGE_ID=$PAGE_ID C1_ID=$C1_ID ==="
echo "JIM_ID=$JIM_ID" > $OUT/ids.env
echo "PAGE_ID=$PAGE_ID" >> $OUT/ids.env
echo "C1_ID=$C1_ID" >> $OUT/ids.env
echo "SPACE_ID=$SPACE_ID" >> $OUT/ids.env
