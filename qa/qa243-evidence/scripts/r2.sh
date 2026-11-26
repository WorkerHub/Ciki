#!/bin/bash
# R2 对象级助手：token 只从本机 wrangler OAuth 读取，绝不落盘/回显
# 用法:
#   r2.sh list <outfile>        全量 LIST（自动翻页）→ 每行 "key<TAB>size<TAB>last_modified"
#   r2.sh get <key> <outfile>   取对象字节到文件
#   r2.sh meta <key>            取对象元数据（HTTP 头）
#   r2.sh delete <key>          按 key 精确删除
set -euo pipefail
TOKEN=$(awk -F'"' '/oauth_token/{print $2}' ~/.wrangler/config/default.toml)
ACCOUNT=967399d1b7212c427f5c032b7f7618f2
BUCKET=ciki-assets
BASE="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/r2/buckets/$BUCKET/objects"
cmd="$1"; shift
case "$cmd" in
  list)
    out="$1"
    : > "$out"
    cursor=""
    pages=0
    while :; do
      url="$BASE?per_page=1000"
      [ -n "$cursor" ] && url="$url&cursor=$cursor"
      resp=$(curl -s --noproxy '*' "$url" -H "Authorization: Bearer $TOKEN")
      echo "$resp" > /tmp/qa243/.r2page.json
      python3 - "$out" <<'PY'
import json,sys
d=json.load(open('/tmp/qa243/.r2page.json'))
if not d.get('success'):
    print('LIST_FAILED', json.dumps(d.get('errors'))[:300]); sys.exit(1)
with open(sys.argv[1],'a') as f:
    for o in d.get('result',[]):
        f.write('%s\t%s\t%s\n' % (o['key'], o['size'], o.get('last_modified')))
PY
      pages=$((pages+1))
      cursor=$(python3 -c "
import json
d=json.load(open('/tmp/qa243/.r2page.json'))
ri=d.get('result_info') or {}
print(ri.get('cursor') or '' if ri.get('is_truncated') else '')
")
      [ -z "$cursor" ] && break
    done
    rm -f /tmp/qa243/.r2page.json
    echo "pages=$pages objects=$(grep -c . "$out" || true) file=$out"
    ;;
  get)
    key="$1"; outfile="$2"
    curl -s --noproxy '*' "$BASE/$key" -H "Authorization: Bearer $TOKEN" -o "$outfile" -w "HTTP %{http_code}\n"
    ;;
  meta)
    key="$1"
    curl -s --noproxy '*' "$BASE/$key" -H "Authorization: Bearer $TOKEN" -I
    ;;
  delete)
    key="$1"
    curl -s --noproxy '*' -X DELETE "$BASE/$key" -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}\n"
    ;;
  *) echo "unknown cmd"; exit 2;;
esac
