#!/bin/bash
# QA254 负例修正：4c-api-permanent 首测误用 POST（404 是方法不存在，非权限拒绝）。
# 补铸 P13（丙，只读条目）重测：A 的 DELETE /api/pages/:id/permanent 应 403；
# 批量接口对 P13 顺带复核 ok:false；最后 B 彻删 P13 清场。
set -euo pipefail
BASE="https://ciki.oneboy.app"
OUT=/tmp/qa254/out
EV=/tmp/qa254/evidence
source /tmp/qa254/tokens.env

st() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }
wcall() {
  local id="$1" tv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Authorization: Bearer ${!tv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
scall() {
  local id="$1" sv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Cookie: ciki_session=${!sv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
must2xx() {
  local code="$(st "$OUT/$1.h")"
  [ "$code" = "200" ] || [ "$code" = "201" ] || { echo "FATAL: $1 got $code: $(head -c 300 "$OUT/$1.b")" >&2; exit 1; }
}
D1Q=/tmp/qa254/scripts/d1q.sh
d1n() { bash "$D1Q" "$1" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'][0]['results'][0]['n'])"; }

echo "== 补铸 P13（丙，B 写令牌）=="
body=$(python3 -c '
import json
doc = {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"QA254 P13 正文：负例重测专用。标记 QA254-P13-UNIQUE"}]}]}
print(json.dumps({"title":"QA254-丙-负例专用页","content_json":doc,"space_id":19,"parent_id":None}))')
wcall pg13 B_WRITE POST /api/write/pages "$body"
must2xx pg13
P13_ID=$(python3 -c "import json;print(json.load(open('$OUT/pg13.b'))['id'])")
echo "P13_ID=$P13_ID"
echo "export P13_ID=$P13_ID" >> /tmp/qa254/state.env
wcall pg13del B_WRITE DELETE "/api/write/pages/$P13_ID"
must2xx pg13del
trashed=$(bash "$D1Q" "SELECT deleted_at FROM pages WHERE id=$P13_ID" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'][0]['results'][0]['deleted_at'])")
[ -n "$trashed" ] || { echo "FATAL: P13 not trashed" >&2; exit 1; }
echo "P13 trashed at $trashed"

echo "== A 负例重测 =="
code1=$(curl -s --noproxy '*' -X POST "$BASE/api/pages/trash/batch" \
  -H "Cookie: ciki_session=$A_SESSION" -H 'Content-Type: application/json' \
  -d "{\"action\":\"purge\",\"ids\":[$P13_ID]}" -o "$OUT/neg_batch_p13.json" -w '%{http_code}')
echo "n1 batch purge [P13] by A -> http=$code1 body=$(cat "$OUT/neg_batch_p13.json")"
still=$(d1n "SELECT COUNT(*) AS n FROM pages WHERE id=$P13_ID AND deleted_at IS NOT NULL")
[ "$still" = "1" ] || { echo "FATAL: P13 changed!" >&2; exit 1; }

code2=$(curl -s --noproxy '*' -X DELETE "$BASE/api/pages/$P13_ID/permanent" \
  -H "Cookie: ciki_session=$A_SESSION" -o "$OUT/neg_perm_p13.json" -w '%{http_code}')
echo "n2 DELETE permanent [P13] by A -> http=$code2 body=$(cat "$OUT/neg_perm_p13.json")"
still2=$(d1n "SELECT COUNT(*) AS n FROM pages WHERE id=$P13_ID AND deleted_at IS NOT NULL")
[ "$still2" = "1" ] || { echo "FATAL: P13 changed!" >&2; exit 1; }

{
  echo "n1=$code1 n2=$code2"
  echo "n1_body=$(cat "$OUT/neg_batch_p13.json")"
  echo "n2_body=$(cat "$OUT/neg_perm_p13.json")"
} | tee "$EV/log/negatives-fixed.txt"

echo "== B 彻删 P13 清场 =="
code3=$(curl -s --noproxy '*' -X DELETE "$BASE/api/pages/$P13_ID/permanent" \
  -H "Cookie: ciki_session=$B_SESSION" -o "$OUT/b_perm_p13.json" -w '%{http_code}')
echo "n3 DELETE permanent [P13] by B (admin) -> http=$code3 body=$(cat "$OUT/b_perm_p13.json")"
gone=$(d1n "SELECT COUNT(*) AS n FROM pages WHERE id=$P13_ID")
revgone=$(d1n "SELECT COUNT(*) AS n FROM page_revisions WHERE page_id=$P13_ID")
echo "P13 after: pages=$gone revisions=$revgone"
[ "$gone" = "0" ] && [ "$revgone" = "0" ] || { echo "FATAL: P13 not purged" >&2; exit 1; }
echo "negatives-fixed done"
