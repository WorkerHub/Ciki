#!/bin/bash
# D1 直查助手（只读用途）：token 只从本机 wrangler OAuth 读取，绝不落盘/回显
# 用法: d1q.sh "<sql>" [params-json] [db-id]
set -euo pipefail
TOKEN=$(awk -F'"' '/oauth_token/{print $2}' ~/.wrangler/config/default.toml)
ACCOUNT=967399d1b7212c427f5c032b7f7618f2
DB="${3:-af4434ef-c73f-4c69-80b7-56695e6737fe}"
SQL="$1"
PARAMS="${2:-[]}"
python3 - "$SQL" "$PARAMS" <<'PY' > /tmp/qa295/.d1req.json
import json,sys
print(json.dumps({"sql": sys.argv[1], "params": json.loads(sys.argv[2])}))
PY
curl -s --noproxy '*' "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/d1/database/$DB/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @/tmp/qa295/.d1req.json
rm -f /tmp/qa295/.d1req.json
