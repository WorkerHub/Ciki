"""QA244: reset the temp QA page (417) to a clean one-paragraph doc.

Used before re-running prod_browser_test.mjs so the run starts from a clean
editor. Records any R2 embed keys referenced before the reset so teardown can
delete precisely those objects later.
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from seed_production import http  # reuse the same retrying http helper

STATE = pathlib.Path("/tmp/qa244-state.json")
EVIDENCE_KEYS = pathlib.Path(__file__).parent.parent / "metrics" / "qa244-embed-keys.json"


def main() -> None:
    state = json.loads(STATE.read_text())
    token = state["sessionToken"]
    page_id = state["pageId"]

    # 1. 记录当前页面正文里引用的 embed key（供终局 R2 精确清理）。
    status, page = http("GET", f"/api/pages/{page_id}", token=token)
    print("GET /api/pages/%s ->" % page_id, status)
    assert status == 200, page
    existing_keys = set()
    if EVIDENCE_KEYS.exists():
        existing_keys = set(json.loads(EVIDENCE_KEYS.read_text()))
    blob = json.dumps(page, ensure_ascii=False)
    marker = "embeds/"
    idx = 0
    while True:
        i = blob.find(marker, idx)
        if i < 0:
            break
        key = blob[i : i + len(marker) + 36 + len(".html")]
        existing_keys.add(key)
        idx = i + 1
    print("embed keys referenced so far:", sorted(existing_keys))

    # 2. 重置正文为单个段落。
    doc = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "QA244 图标验收页"}]}
        ],
    }
    status, resp = http(
        "PUT",
        f"/api/pages/{page_id}",
        {
            "title": "QA244 图标验收页",
            "contentJson": json.dumps(doc, ensure_ascii=False),
            "contentHtml": "<p>QA244 图标验收页</p>",
            "contentText": "QA244 图标验收页",
        },
        token=token,
    )
    print("PUT /api/pages/%s ->" % page_id, status)
    assert status == 200, resp

    EVIDENCE_KEYS.write_text(json.dumps(sorted(existing_keys), ensure_ascii=False, indent=2))
    print("keys recorded ->", EVIDENCE_KEYS)


if __name__ == "__main__":
    main()
