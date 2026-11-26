#!/bin/bash
# QA254 P8 修正：恢复 → 两轮不同内容编辑（v2b/v3b）→ 重新软删
# 原因：pgedit 首版误将页面 id 作为正文写入（v2 内容为 text="426"，v3 因内容相同未建行）。
set -euo pipefail
BASE="https://ciki.oneboy.app"
OUT=/tmp/qa254/out
EV=/tmp/qa254/evidence
source /tmp/qa254/tokens.env
source /tmp/qa254/state.env

st() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }
scall() {
  local id="$1" sv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Cookie: ciki_session=${!sv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
wcall() {
  local id="$1" tv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Authorization: Bearer ${!tv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
must2xx() {
  local code="$(st "$OUT/$1.h")"
  [ "$code" = "200" ] || [ "$code" = "201" ] || { echo "FATAL: $1 got $code: $(head -c 300 "$OUT/$1.b")" >&2; exit 1; }
}
pgedit() { # pgedit <id> <token_var> <page_id> <text>
  local body
  body=$(python3 -c '
import json,sys
doc = {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":sys.argv[1]}]}]}
print(json.dumps({"content_json": doc}))' "$4")
  wcall "$1" "$2" PUT "/api/write/pages/$3" "$body"
  must2xx "$1"
}

echo "== 恢复 P8（写接口，铸数设施性操作）=="
scall p8restore A_SESSION POST "/api/pages/$P8_ID/restore"
must2xx p8restore
bash /tmp/qa254/scripts/d1q.sh "SELECT id, deleted_at, version_no FROM pages WHERE id=$P8_ID" | tee "$EV/log/p8-after-restore.json"

echo "== P8 编辑 v2b =="
pgedit p8e2b A_WRITE "$P8_ID" "QA254 P8 正文 v2b：修正后的第一轮编辑。标记 QA254-P8-V2B"
sleep 1.1
echo "== P8 编辑 v3b =="
pgedit p8e3b A_WRITE "$P8_ID" "QA254 P8 正文 v3b：修正后的第二轮编辑。标记 QA254-P8-V3B"

echo "== 重新软删 P8 =="
before=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
wcall p8redel A_WRITE DELETE "/api/write/pages/$P8_ID"
must2xx p8redel
after=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
echo "DEL_P8_REDEL_WINDOW=[$before,$after]" | tee -a "$EV/log/del-windows.txt"

echo "== P8 版本行终态 =="
bash /tmp/qa254/scripts/d1q.sh "SELECT page_id, version_no, content_hash, created_at FROM page_revisions WHERE page_id=$P8_ID ORDER BY version_no" | tee "$EV/log/p8-revisions-final.json"
echo "== P8 当前内容 =="
bash /tmp/qa254/scripts/d1q.sh "SELECT id, deleted_at, substr(content_text,1,50) AS tp, content_hash FROM pages WHERE id=$P8_ID" | tee "$EV/log/p8-current.json"
