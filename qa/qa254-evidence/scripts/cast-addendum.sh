#!/bin/bash
# QA254 补铸：P10(甲, 父)+P11(甲, 子) 子树 + P12(甲, 单页)；软删顺序 P12 → P10(子树) → P9
# 用途分配：P10 子树=批量恢复(跨空间)、P1 子树=批量彻删(跨空间)、P12=A 清空、P9=乙空间批量彻删对象
set -euo pipefail
BASE="https://ciki.oneboy.app"
OUT=/tmp/qa254/out
EV=/tmp/qa254/evidence
source /tmp/qa254/tokens.env
source /tmp/qa254/state.env

st() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }
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
jget() { python3 -c "import json,sys;d=json.load(open('$OUT/$1.b'));print(d$2)"; }
mkpage() {
  local id="$1" tv="$2" sid="$3" pid="$4" title="$5" text="$6"
  local body
  body=$(python3 -c '
import json,sys
sid, pid, title, text = sys.argv[1:5]
doc = {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]}
body = {"title": title, "content_json": doc, "space_id": int(sid),
        "parent_id": None if pid == "-" else int(pid)}
print(json.dumps(body))' "$sid" "$pid" "$title" "$text")
  wcall "$id" "$tv" POST /api/write/pages "$body"
  must2xx "$id"
}
del() {
  local before after
  before=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  wcall "$1" "$2" DELETE "/api/write/pages/$3"
  must2xx "$1"
  after=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
  echo "DEL_${1}_WINDOW=[$before,$after]"
}

echo "== 补铸页面 =="
mkpage pg10 A_WRITE "$SA_ID" -       "QA254-甲-子树页-批量恢复用" "QA254 P10 正文：批量恢复子树对象。标记 QA254-P10-UNIQUE"
P10_ID=$(jget pg10 "['id']")
mkpage pg11 A_WRITE "$SA_ID" "$P10_ID" "QA254-甲-子树子页"      "QA254 P11 正文：P10 的子页。标记 QA254-P11-UNIQUE"
P11_ID=$(jget pg11 "['id']")
mkpage pg12 A_WRITE "$SA_ID" -       "QA254-甲-清空单空间用页"  "QA254 P12 正文：A 清空（全部）对象。标记 QA254-P12-UNIQUE"
P12_ID=$(jget pg12 "['id']")

echo "== 软删（P12 → P10 子树 → P9）=="
{ del d12 A_WRITE "$P12_ID"
  sleep 1.1
  del d10 A_WRITE "$P10_ID"
  sleep 1.1
  del d9 A_WRITE "$P9_ID"
} | tee "$EV/log/del-windows-addendum.txt"

cat >> /tmp/qa254/state.env <<EOF
export P10_ID=$P10_ID
export P11_ID=$P11_ID
export P12_ID=$P12_ID
EOF
echo "addendum done: P10=$P10_ID P11=$P11_ID P12=$P12_ID"
