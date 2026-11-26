#!/bin/bash
# 测后拆除：R2 按 key 精确删除 + D1 删铸造行；随后终核（残留=0、基线不变、令牌失效）。
set -uo pipefail
cd /tmp/qa243
source ./tokens.env
source ./user-ids.env
EMBED_KEY=$(cut -d'|' -f1 keys.txt | cut -d' ' -f1)
IMAGE_KEY=$(cut -d'|' -f2 keys.txt | cut -d' ' -f2)
SCENE_KEY=$(cut -d'|' -f3 keys.txt | cut -d' ' -f3)
echo "待删对象: $EMBED_KEY / $IMAGE_KEY / $SCENE_KEY"

echo "### 上传后 R2 全量清单（应为基线+3）"
./r2.sh list r2-during.tsv
diff <(cut -f1 r2-before.tsv | sort) <(cut -f1 r2-during.tsv | sort) | grep '^>' || true

echo "### 1) R2 按 key 精确删除"
for k in "$EMBED_KEY" "$IMAGE_KEY" "$SCENE_KEY"; do
  echo "-- $k"
  ./r2.sh delete "$k"
done

echo "### 2) D1 删除铸造行（令牌 → 计数 → 用户）"
./d1q.sh "delete from api_tokens where id in (16,17,18,19)" >/dev/null && echo "api_tokens deleted"
./d1q.sh "delete from auth_counters where account in ('18312','18313')" >/dev/null && echo "auth_counters deleted"
./d1q.sh "delete from users where id in (18312,18313)" >/dev/null && echo "users deleted"

echo "### 3) 终核"
./r2.sh list r2-after.tsv
echo "-- R2 键集合差异（应为空）："
diff <(cut -f1 r2-before.tsv | sort) <(cut -f1 r2-after.tsv | sort) && echo "R2_KEYSET_IDENTICAL"
echo "-- D1 计数："
./d1q.sh "select (select count(*) from users) as users, (select count(*) from spaces) as spaces, (select count(*) from space_members) as members, (select count(*) from pages) as pages, (select count(*) from pages where deleted_at is null) as active_pages, (select count(*) from api_tokens) as api_tokens, (select count(*) from sessions) as sessions, (select count(*) from comments) as comments, (select count(*) from notifications) as notifications, (select count(*) from auth_counters) as auth_counters" | python3 -c "
import json,sys
print(json.load(sys.stdin)['result'][0]['results'][0])
"
echo "-- 残留 QA 用户/令牌："
./d1q.sh "select (select count(*) from users where email like '%qa243%' or username like 'qa243%') as qa_users, (select count(*) from api_tokens where name like 'qa243%') as qa_tokens, (select count(*) from auth_counters where account in ('18312','18313')) as qa_counters" | python3 -c "
import json,sys
print(json.load(sys.stdin)['result'][0]['results'][0])
"
echo "-- 铸造的令牌现在应 401："
curl -s --noproxy '*' -o /dev/null -w "A_READ HTTP %{http_code}\n" https://ciki.oneboy.app/api/read/spaces -H "Authorization: Bearer $A_READ"
curl -s --noproxy '*' -o /dev/null -w "B_WRITE HTTP %{http_code}\n" https://ciki.oneboy.app/api/read/spaces -H "Authorization: Bearer $B_WRITE"
echo "-- 已删对象读回应 404："
curl -s --noproxy '*' -w "\nembed HTTP %{http_code}\n" "https://ciki.oneboy.app/api/read/files/$EMBED_KEY" -H "Authorization: Bearer $A_READ"
