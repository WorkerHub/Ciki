#!/bin/bash
# QA254 铸后状态快照：QA 页面/版本/空间的权威行，供 UI 跑各步骤比对
set -euo pipefail
EV=/tmp/qa254/evidence
source /tmp/qa254/state.env

bash /tmp/qa254/scripts/d1q.sh "SELECT id, space_id, parent_id, title, created_at, updated_at, deleted_at, content_hash, length(content_text) AS text_len FROM pages WHERE title LIKE 'QA254-%' ORDER BY id" > "$EV/log/cast-pages.json"
bash /tmp/qa254/scripts/d1q.sh "SELECT page_id, version_no, title, content_hash, created_at FROM page_revisions WHERE page_id IN (SELECT id FROM pages WHERE title LIKE 'QA254-%') ORDER BY page_id, version_no" > "$EV/log/cast-revisions.json"
bash /tmp/qa254/scripts/d1q.sh "SELECT id, name, slug, created_at FROM spaces WHERE name LIKE 'QA254%' ORDER BY id" > "$EV/log/cast-spaces.json"
bash /tmp/qa254/scripts/d1q.sh "SELECT space_id, user_id, role FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE name LIKE 'QA254%') ORDER BY space_id, user_id" > "$EV/log/cast-members.json"

# 内容对象 key 清单（content/<sha256>），拆除时逐一核对引用后删除
bash /tmp/qa254/scripts/d1q.sh "SELECT DISTINCT content_hash FROM pages WHERE title LIKE 'QA254-%'
  UNION SELECT DISTINCT r.content_hash FROM page_revisions r WHERE r.page_id IN (SELECT id FROM pages WHERE title LIKE 'QA254-%')" > /tmp/qa254/content-hashes.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/qa254/content-hashes.json'))
hashes = sorted({row['content_hash'] for row in d['result'][0]['results']})
open('/tmp/qa254/content-keys.txt','w').write('\n'.join('content/'+h for h in hashes)+'\n')
print(f"content keys: {len(hashes)}")
PY
python3 - <<'PY'
import json
for name in ('cast-pages','cast-revisions','cast-spaces','cast-members'):
    d = json.load(open(f'/tmp/qa254/evidence/log/{name}.json'))
    rows = d['result'][0]['results']
    print(f"{name}: {len(rows)} rows")
PY
echo "cast-state snapshot done"
