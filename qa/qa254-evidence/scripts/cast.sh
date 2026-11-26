#!/bin/bash
# QA254 铸数：空间 ×3（甲乙=owner_a admin，丙=owner_b admin + owner_a viewer）、页面 ×9、
# P8 两轮正文编辑（3 版本）、软删 P1(子树)/P4/P5/P6/P7/P8。
# 只在 QA 自有空间造数；令牌明文从 /tmp/qa254/tokens.env 读，不打印、不落证据。
set -euo pipefail
BASE="https://ciki.oneboy.app"
OUT=/tmp/qa254/out
EV=/tmp/qa254/evidence
mkdir -p "$OUT"
source /tmp/qa254/tokens.env

st() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }
# scall <id> <session_var> <method> <path> [json-body]：会话 Cookie 调用
scall() {
  local id="$1" sv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Cookie: ciki_session=${!sv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
# wcall <id> <token_var> <method> <path> [json-body]：Bearer 写令牌调用
wcall() {
  local id="$1" tv="$2" method="$3" path="$4" body="${5:-}"
  local args=(-s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}'
    -H "Authorization: Bearer ${!tv}" -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "$BASE$path"
  echo "  $id -> $(st "$OUT/$id.h")" >&2
}
jget() { python3 -c "import json,sys;d=json.load(open('$OUT/$1.b'));print(d$2)"; }  # 调用形如 jget sp_a "['id']"
must2xx() {
  local code="$(st "$OUT/$1.h")"
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    echo "FATAL: $1 expected 200/201 got $code: $(head -c 300 "$OUT/$1.b")" >&2
    exit 1
  fi
}
# mkpage <id> <token_var> <space_id> <parent_id_or_-> <title> <text>
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
# pgedit <id> <token_var> <page_id> <text>
pgedit() {
  local body
  body=$(python3 -c '
import json,sys
doc = {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":sys.argv[1]}]}]}
print(json.dumps({"content_json": doc}))' "$3")
  wcall "$1" "$2" PUT "/api/write/pages/$3" "$body"
  must2xx "$1"
}

echo "== 基线快照 =="
bash /tmp/qa254/scripts/baseline.sh snapshot | tee "$EV/log/baseline-and-teardown.txt"

echo "== 建空间（甲/乙 by A，丙 by B）=="
scall sp_a A_SESSION POST /api/spaces '{"name":"QA254 空间甲","description":"QA254 验收空间 甲"}'
must2xx sp_a
scall sp_b A_SESSION POST /api/spaces '{"name":"QA254 空间乙","description":"QA254 验收空间 乙"}'
must2xx sp_b
scall sp_c B_SESSION POST /api/spaces '{"name":"QA254 空间丙","description":"QA254 验收空间 丙（A 为只读成员）"}'
must2xx sp_c
SA_ID=$(jget sp_a "['id']"); SA_SLUG=$(jget sp_a "['slug']")
SB_ID=$(jget sp_b "['id']"); SB_SLUG=$(jget sp_b "['slug']")
SC_ID=$(jget sp_c "['id']"); SC_SLUG=$(jget sp_c "['slug']")
echo "SA=$SA_ID($SA_SLUG) SB=$SB_ID($SB_SLUG) SC=$SC_ID($SC_SLUG)" | tee "$EV/log/spaces.txt"

echo "== A 以 viewer 加入丙 =="
scall mem_add B_SESSION POST "/api/spaces/$SC_ID/members" "{\"userId\":$UID_QA254_OWNER_A,\"role\":\"viewer\"}"
must2xx mem_add

echo "== 建页（甲/乙 by A 令牌，丙 by B 令牌）=="
mkpage pg1 A_WRITE "$SA_ID" -  "QA254-甲-父页-含子树"  "QA254 P1 正文：父页，将被软删后整树恢复/彻删验证。标记 QA254-P1-UNIQUE"
P1_ID=$(jget pg1 "['id']")
mkpage pg2 A_WRITE "$SA_ID" "$P1_ID" "QA254-甲-子页一"   "QA254 P2 正文：子页一。标记 QA254-P2-UNIQUE"
mkpage pg3 A_WRITE "$SA_ID" "$P1_ID" "QA254-甲-子页二"   "QA254 P3 正文：子页二。标记 QA254-P3-UNIQUE"
mkpage pg4 A_WRITE "$SB_ID" -  "QA254-乙-单页"        "QA254 P4 正文：乙空间单页。标记 QA254-P4-UNIQUE"
mkpage pg5 A_WRITE "$SB_ID" -  "QA254-乙-待单条彻删"   "QA254 P5 正文：单条彻底删除对象。标记 QA254-P5-UNIQUE"
mkpage pg6 B_WRITE "$SC_ID" -  "QA254-丙-只读页"      "QA254 P6 正文：丙空间（A 只读）。标记 QA254-P6-UNIQUE"
mkpage pg7 B_WRITE "$SC_ID" -  "QA254-丙-只读页二"    "QA254 P7 正文：丙空间（A 只读）。标记 QA254-P7-UNIQUE"
mkpage pg8 A_WRITE "$SA_ID" -  "QA254-甲-版本历史页"   "QA254 P8 正文 v1：版本语义验证。标记 QA254-P8-V1"
mkpage pg9 A_WRITE "$SB_ID" -  "QA254-乙-清空全部用页" "QA254 P9 正文：清空（全部）对象。标记 QA254-P9-UNIQUE"
P2_ID=$(jget pg2 "['id']"); P3_ID=$(jget pg3 "['id']"); P4_ID=$(jget pg4 "['id']")
P5_ID=$(jget pg5 "['id']"); P6_ID=$(jget pg6 "['id']"); P7_ID=$(jget pg7 "['id']")
P8_ID=$(jget pg8 "['id']"); P9_ID=$(jget pg9 "['id']")
echo "P1..P9 = $P1_ID $P2_ID $P3_ID $P4_ID $P5_ID $P6_ID $P7_ID $P8_ID $P9_ID" | tee "$EV/log/pages.txt"

echo "== P8 两轮编辑（v2/v3）=="
pgedit pg8e1 A_WRITE "$P8_ID" "QA254 P8 正文 v2：第一轮编辑。标记 QA254-P8-V2"
sleep 1.1
pgedit pg8e2 A_WRITE "$P8_ID" "QA254 P8 正文 v3：第二轮编辑。标记 QA254-P8-V3"

echo "== 软删（P1 子树 / P4 / P5 / P6 / P7 / P8）=="
del() { # del <id> <token_var> <page_id>
  local before after
  before=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  wcall "$1" "$2" DELETE "/api/write/pages/$3"
  must2xx "$1"
  after=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
  echo "DEL_${1}_WINDOW=[$before,$after]"
}
{ del d1 A_WRITE "$P1_ID"
  sleep 1.1
  del d4 A_WRITE "$P4_ID"
  sleep 1.1
  del d5 A_WRITE "$P5_ID"
  sleep 1.1
  del d6 B_WRITE "$P6_ID"
  sleep 1.1
  del d7 B_WRITE "$P7_ID"
  sleep 1.1
  del d8 A_WRITE "$P8_ID"
} | tee "$EV/log/del-windows.txt"

cat > /tmp/qa254/state.env <<EOF
export SA_ID=$SA_ID
export SA_SLUG=$SA_SLUG
export SB_ID=$SB_ID
export SB_SLUG=$SB_SLUG
export SC_ID=$SC_ID
export SC_SLUG=$SC_SLUG
export P1_ID=$P1_ID
export P2_ID=$P2_ID
export P3_ID=$P3_ID
export P4_ID=$P4_ID
export P5_ID=$P5_ID
export P6_ID=$P6_ID
export P7_ID=$P7_ID
export P8_ID=$P8_ID
export P9_ID=$P9_ID
EOF
echo "state.env written"
