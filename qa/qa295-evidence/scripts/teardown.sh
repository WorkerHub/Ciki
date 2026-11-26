#!/bin/bash
# QA #295 拆除脚本：精确删除本轮铸造的 QA 账号及其会话，不碰任何他人数据。
#
# 用法：
#   export QA_UID=18314 QA_AGENT_UID=18315
#   export QA_D1Q=/tmp/qa295/d1q.sh
#   ./teardown.sh
set -euo pipefail

D1Q="${QA_D1Q:-/tmp/qa295/d1q.sh}"
UIDS="${QA_UID:?QA_UID required},${QA_AGENT_UID:?QA_AGENT_UID required}"

echo "== 删除前 users 表 =="
"$D1Q" "SELECT id, email, username, kind, role FROM users ORDER BY id"

# 顺序：先子表后主表
"$D1Q" "DELETE FROM sessions WHERE user_id IN ($UIDS)"
"$D1Q" "DELETE FROM users WHERE id IN ($UIDS)"

echo "== 删除后 users 表 =="
"$D1Q" "SELECT id, email, username, kind, role FROM users ORDER BY id"

echo "== 残留检查（应全为 0）=="
"$D1Q" "SELECT
  (SELECT COUNT(*) FROM users WHERE id IN ($UIDS)) users,
  (SELECT COUNT(*) FROM sessions WHERE user_id IN ($UIDS)) sessions,
  (SELECT COUNT(*) FROM api_tokens WHERE user_id IN ($UIDS)) api_tokens,
  (SELECT COUNT(*) FROM space_members WHERE user_id IN ($UIDS)) space_members,
  (SELECT COUNT(*) FROM pages WHERE created_by IN ($UIDS) OR updated_by IN ($UIDS)) pages,
  (SELECT COUNT(*) FROM comments WHERE author_id IN ($UIDS)) comments,
  (SELECT COUNT(*) FROM notifications WHERE recipient_id IN ($UIDS) OR actor_id IN ($UIDS)) notifications"

echo "== 已删账号登录复核（应 401）=="
for e in "${QA_EMAIL:-qa295admin@qa.test}" "${QA_AGENT_EMAIL:-qa295agent@qa.test}"; do
  code=$(curl -sS --noproxy '*' -m 20 -o /dev/null -w '%{http_code}' \
    -X POST https://ciki.oneboy.app/api/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$e\",\"password\":\"${QA_PASSWORD:-invalid}\"}")
  echo "$e -> HTTP $code"
done
