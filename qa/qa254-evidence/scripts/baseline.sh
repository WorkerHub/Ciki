#!/bin/bash
# QA254 基线/终核：生产 D1 计数 + QA 残留检查
# 用法: baseline.sh snapshot | verify
set -euo pipefail
D1Q=/tmp/qa254/scripts/d1q.sh

cnt() { # cnt <label> <sql>
  local out
  out=$(bash "$D1Q" "$2")
  local n
  n=$(python3 -c "
import json,sys
d=json.loads('''$out''')
print(d['result'][0]['results'][0]['n'])")
  echo "$1=$n"
}

if [ "$1" = "snapshot" ]; then
  echo "== QA254 基线快照 $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
  cnt users_total        "SELECT COUNT(*) AS n FROM users"
  cnt spaces_total       "SELECT COUNT(*) AS n FROM spaces"
  cnt pages_active       "SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL"
  cnt pages_trashed      "SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL"
  cnt revisions_total    "SELECT COUNT(*) AS n FROM page_revisions"
  cnt sessions_total     "SELECT COUNT(*) AS n FROM sessions"
  cnt api_tokens_total   "SELECT COUNT(*) AS n FROM api_tokens"
  cnt space_members_total "SELECT COUNT(*) AS n FROM space_members"
  cnt qa_users           "SELECT COUNT(*) AS n FROM users WHERE email LIKE 'qa254%@qa.test' OR username LIKE 'qa254_%'"
  cnt qa_spaces          "SELECT COUNT(*) AS n FROM spaces WHERE name LIKE 'QA254%'"
  cnt qa_pages           "SELECT COUNT(*) AS n FROM pages WHERE title LIKE 'QA254-%'"
  cnt qa_sessions        "SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa254_%')"
  cnt qa_tokens          "SELECT COUNT(*) AS n FROM api_tokens WHERE name LIKE 'qa254-%'"
  cnt auth_counters_total "SELECT COUNT(*) AS n FROM auth_counters"
else
  echo "== QA254 终核 $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
  cnt users_total        "SELECT COUNT(*) AS n FROM users"
  cnt spaces_total       "SELECT COUNT(*) AS n FROM spaces"
  cnt pages_active       "SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NULL"
  cnt pages_trashed      "SELECT COUNT(*) AS n FROM pages WHERE deleted_at IS NOT NULL"
  cnt revisions_total    "SELECT COUNT(*) AS n FROM page_revisions"
  cnt sessions_total     "SELECT COUNT(*) AS n FROM sessions"
  cnt api_tokens_total   "SELECT COUNT(*) AS n FROM api_tokens"
  cnt space_members_total "SELECT COUNT(*) AS n FROM space_members"
  echo "-- QA 残留（全部必须为 0）--"
  cnt qa_users           "SELECT COUNT(*) AS n FROM users WHERE email LIKE 'qa254%@qa.test' OR username LIKE 'qa254_%'"
  cnt qa_spaces          "SELECT COUNT(*) AS n FROM spaces WHERE name LIKE 'QA254%' OR slug LIKE 'qa254%'"
  cnt qa_pages           "SELECT COUNT(*) AS n FROM pages WHERE title LIKE 'QA254-%'"
  cnt qa_revisions       "SELECT COUNT(*) AS n FROM page_revisions WHERE page_id NOT IN (SELECT id FROM pages)"
  cnt qa_fts             "SELECT COUNT(*) AS n FROM pages_fts WHERE page_id NOT IN (SELECT id FROM pages)"
  cnt qa_members         "SELECT COUNT(*) AS n FROM space_members WHERE user_id NOT IN (SELECT id FROM users)"
  cnt qa_sessions        "SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'qa254_%')"
  cnt qa_tokens          "SELECT COUNT(*) AS n FROM api_tokens WHERE name LIKE 'qa254-%'"
  cnt auth_counters_total "SELECT COUNT(*) AS n FROM auth_counters"
fi
