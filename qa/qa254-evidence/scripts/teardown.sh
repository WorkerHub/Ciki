#!/bin/bash
# QA254 拆除：活动页面→永久删除→R2 内容对象→空间→会话/令牌/用户，最后 baseline verify。
# 任何一步与预期不符立即中止，绝不继续破坏性操作。
set -euo pipefail
BASE="https://ciki.oneboy.app"
OUT=/tmp/qa254/out
EV=/tmp/qa254/evidence
source /tmp/qa254/tokens.env
D1Q=/tmp/qa254/scripts/d1q.sh

st() { grep -i '^HTTP/' "$1" | tail -1 | awk '{print $2}'; }
wcall() {
  local id="$1" tv="$2" method="$3" path="$4"
  curl -s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}' \
    -H "Authorization: Bearer ${!tv}" -H 'Content-Type: application/json' "$BASE$path" >/dev/null
  echo "  $id $(st "$OUT/$id.h")"
}
scall() {
  local id="$1" sv="$2" method="$3" path="$4"
  curl -s --noproxy '*' -X "$method" -D "$OUT/$id.h" -o "$OUT/$id.b" -w '%{http_code}' \
    -H "Cookie: ciki_session=${!sv}" -H 'Content-Type: application/json' "$BASE$path" >/dev/null
  echo "  $id $(st "$OUT/$id.h")"
}
must2xx() {
  local code="$(st "$OUT/$1.h")"
  [ "$code" = "200" ] || [ "$code" = "201" ] || { echo "FATAL: $1 got $code: $(head -c 300 "$OUT/$1.b")" >&2; exit 1; }
}
d1n() { bash "$D1Q" "$1" | python3 -c "import json,sys;print(json.load(sys.stdin)['result'][0]['results'][0]['n'])"; }
d1list() { bash "$D1Q" "$1" | python3 -c "
import json,sys
for r in json.load(sys.stdin)['result'][0]['results']: print(r['content_hash'])"; }

P4=422; P8=426; P10=428; P11=429
LOG=$EV/log/teardown.txt
exec > >(tee -a "$LOG") 2>&1
echo "== QA254 拆除开始 $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

echo "-- 1. 构建确定性 QA 内容哈希集合并对账 --"
HASHES=$(python3 - <<'PY'
import json, hashlib
h = set()
for f in ('cast-pages.json', 'cast-revisions.json'):
    d = json.load(open(f'/tmp/qa254/evidence/log/{f}'))
    for row in d['result'][0]['results']:
        h.add(row['content_hash'])
p13key = [l.strip() for l in open('/tmp/qa254/state.env') if l.startswith('P13_KEY=')][0].split('=',1)[1]
h.add(p13key.split('/',1)[1])
keys = {l.strip() for l in open('/tmp/qa254/content-keys.txt') if l.strip()}
mine = {'content/'+x for x in h}
if mine != keys:
    print('SET-MISMATCH', file=__import__('sys').stderr)
    print('only-in-definitive:', sorted(mine-keys), file=__import__('sys').stderr)
    print('only-in-keys-file:', sorted(keys-mine), file=__import__('sys').stderr)
    raise SystemExit(1)
print('\n'.join(sorted(h)))
PY
)
echo "$HASHES" > /tmp/qa254/definitive-hashes.txt
echo "definitive hashes: $(echo "$HASHES" | wc -l | tr -d ' ')"

echo "-- 2. 活动页引用均在集合内 --"
NOW=$(d1list "SELECT DISTINCT content_hash FROM pages WHERE id IN ($P4,$P8,$P10,$P11)
  UNION SELECT DISTINCT r.content_hash FROM page_revisions r WHERE r.page_id IN ($P4,$P8,$P10,$P11)")
echo "$NOW" | while read -r hh; do grep -qx "$hh" /tmp/qa254/definitive-hashes.txt || { echo "FATAL: hash $hh not in definitive set" >&2; exit 1; }; done
echo "referenced-now: $(echo "$NOW" | wc -l | tr -d ' ') (all inside definitive set)"

echo "-- 3. 软删活动页（写令牌，A）--"
wcall td-p4   A_WRITE DELETE "/api/write/pages/$P4"  && must2xx td-p4
wcall td-p8   A_WRITE DELETE "/api/write/pages/$P8"  && must2xx td-p8
wcall td-p10  A_WRITE DELETE "/api/write/pages/$P10" && must2xx td-p10
trashed=$(d1n "SELECT COUNT(*) AS n FROM pages WHERE id IN ($P4,$P8,$P10,$P11) AND deleted_at IS NOT NULL")
[ "$trashed" = "4" ] || { echo "FATAL: expected 4 trashed incl P11, got $trashed" >&2; exit 1; }
echo "4 pages (P4/P8/P10/P11) in trash"

echo "-- 4. 永久删除（会话，A）--"
for pid in $P4 $P8 $P10; do
  scall tperm-$pid A_SESSION DELETE "/api/pages/$pid/permanent" && must2xx tperm-$pid
done
pg=$(d1n "SELECT COUNT(*) AS n FROM pages WHERE id IN ($P4,$P8,$P10,$P11)")
rv=$(d1n "SELECT COUNT(*) AS n FROM page_revisions WHERE page_id IN ($P4,$P8,$P10,$P11)")
ft=$(d1n "SELECT COUNT(*) AS n FROM pages_fts WHERE page_id IN ($P4,$P8,$P10,$P11)")
[ "$pg" = "0" ] && [ "$rv" = "0" ] && [ "$ft" = "0" ] || { echo "FATAL: residue pg=$pg rv=$rv ft=$ft" >&2; exit 1; }
echo "pages/revisions/fts for QA ids: 0/0/0"

echo "-- 5. D1 引用清零后删除 R2 内容对象 --"
TOKEN=$(awk -F'"' '/oauth_token/{print $2}' ~/.wrangler/config/default.toml)
RB="https://api.cloudflare.com/client/v4/accounts/967399d1b7212c427f5c032b7f7618f2/r2/buckets/ciki-content/objects"
while read -r hh; do
  code=$(curl -s --noproxy '*' -X DELETE "$RB/content/$hh" -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}')
  chk=$(curl -s --noproxy '*' "$RB/content/$hh" -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}')
  echo "  content/$hh del=$code post-get=$chk"
  [ "$chk" = "404" ] || { echo "FATAL: object content/$hh still exists (get=$chk)" >&2; exit 1; }
done < /tmp/qa254/definitive-hashes.txt
echo "all $(echo "$HASHES" | wc -l | tr -d ' ') content objects deleted"

echo "-- 6. 删除 QA 空间（17/18 by A, 19 by B）--"
for sid in 17 18; do
  scall tspace-$sid A_SESSION DELETE "/api/spaces/$sid" && must2xx tspace-$sid
done
scall tspace-19 B_SESSION DELETE "/api/spaces/19" && must2xx tspace-19
sp=$(d1n "SELECT COUNT(*) AS n FROM spaces WHERE id IN (17,18,19)")
mb=$(d1n "SELECT COUNT(*) AS n FROM space_members WHERE space_id IN (17,18,19)")
[ "$sp" = "0" ] && [ "$mb" = "0" ] || { echo "FATAL: spaces=$sp members=$mb" >&2; exit 1; }
echo "spaces 17/18/19 + members: 0/0"

echo "-- 7. 会话、令牌、用户 --"
bash "$D1Q" "DELETE FROM sessions WHERE user_id IN (18316,18317)" >/dev/null
bash "$D1Q" "DELETE FROM api_tokens WHERE user_id IN (18316,18317)" >/dev/null
bash "$D1Q" "DELETE FROM space_members WHERE user_id IN (18316,18317)" >/dev/null
bash "$D1Q" "DELETE FROM users WHERE id IN (18316,18317)" >/dev/null
us=$(d1n "SELECT COUNT(*) AS n FROM users WHERE id IN (18316,18317)")
se=$(d1n "SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (18316,18317)")
tk=$(d1n "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id IN (18316,18317)")
mb2=$(d1n "SELECT COUNT(*) AS n FROM space_members WHERE user_id IN (18316,18317)")
[ "$us$se$tk$mb2" = "0000" ] || { echo "FATAL: users=$us sessions=$se tokens=$tk members=$mb2" >&2; exit 1; }
echo "users/sessions/tokens/members for 18316/18317: 0/0/0/0"

echo "-- 8. 撤销后会话验证（预期 401）--"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Cookie: ciki_session=$A_SESSION")
echo "GET /api/me with revoked session -> $code"
[ "$code" = "401" ] || { echo "FATAL: revoked session still valid ($code)" >&2; exit 1; }
echo "== 拆除完成，执行 baseline verify =="
bash /tmp/qa254/scripts/baseline.sh verify
