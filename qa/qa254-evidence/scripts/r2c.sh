#!/bin/bash
# R2 对象级助手（QA254，内容桶）：token 只从本机 wrangler OAuth 读取，绝不落盘/回显
# 用法:
#   r2c.sh meta <key>       取对象元数据（HTTP 头）
#   r2c.sh delete <key>     按 key 精确删除
set -euo pipefail
TOKEN=$(awk -F'"' '/oauth_token/{print $2}' ~/.wrangler/config/default.toml)
ACCOUNT=967399d1b7212c427f5c032b7f7618f2
BUCKET=ciki-content
BASE="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/r2/buckets/$BUCKET/objects"
cmd="$1"; shift
case "$cmd" in
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
