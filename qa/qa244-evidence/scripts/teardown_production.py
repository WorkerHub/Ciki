"""QA244 teardown: remove ALL temporary production data created for this QA run.

Order (dependencies):
  1. soft-delete page 417  (DELETE /api/pages/417)
  2. permanent-delete page 417 (DELETE /api/pages/417/permanent — removes
     revisions, comments, pages_fts, pages rows)
  3. delete space (DELETE /api/spaces/:id — also removes space_members)
  4. delete QA session + user rows directly in D1
  5. delete the exact R2 embed objects uploaded during this run
     (keys recorded in metrics/qa244-embed-keys.json)
  6. verify: D1 counts and R2 object listing back to the pre-run baseline
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from baseline import counts, r2_snapshot  # noqa: E402
from cf_api import ACCOUNT_ID, call_raw, d1_query  # noqa: E402
from seed_production import DB, http  # noqa: E402

STATE = pathlib.Path("/tmp/qa244-state.json")
KEYS_FILE = pathlib.Path(__file__).parent.parent / "metrics" / "qa244-embed-keys.json"
BUCKET = "ciki-assets"

BASELINE = {
    "users": 4,
    "spaces": 8,
    "space_members": 21,
    "pages_active": 387,
    "pages_total": 389,
    "page_revisions": 825,
    "sessions": 14,
    "api_tokens": 9,
    "comments": 8,
    "notifications": 0,
}
BASELINE_R2 = {"ciki-assets": 1389, "ciki-content": 975}


def main() -> None:
    state = json.loads(STATE.read_text())
    token = state["sessionToken"]
    page_id = state["pageId"]
    space_id = state["spaceId"]
    user_id = state["userId"]
    session_id = state["sessionId"]

    # 1+2. 页面：软删 → 永久删（连带修订 / FTS / 评论）
    status, resp = http("DELETE", f"/api/pages/{page_id}", token=token)
    print(f"DELETE /api/pages/{page_id} ->", status, resp)
    assert status == 200, resp
    status, resp = http("DELETE", f"/api/pages/{page_id}/permanent", token=token)
    print(f"DELETE /api/pages/{page_id}/permanent ->", status, resp)
    assert status == 200, resp

    # 3. 空间（连带 space_members；要求空间内已无页面）
    status, resp = http("DELETE", f"/api/spaces/{space_id}", token=token)
    print(f"DELETE /api/spaces/{space_id} ->", status, resp)
    assert status == 200, resp

    # 4. 会话 + 用户（直接 D1；api_tokens 属于其他用户，不动）
    d1_query(DB, "delete from sessions where id = ?", [session_id])
    d1_query(DB, "delete from sessions where user_id = ?", [user_id])
    d1_query(DB, "delete from users where id = ?", [user_id])
    print(f"D1: session {session_id} + user {user_id} deleted")

    # 5. R2：精确删除本次上传的 embed 对象
    keys = json.loads(KEYS_FILE.read_text())
    for key in keys:
        env = call_raw("DELETE", f"/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects/{key}")
        print("R2 delete", key, "->", "ok" if env.get("success") else env.get("errors"))

    # 6. 终核：D1 计数回到基线、R2 对象数回到基线、QA 残留为零
    final = counts()
    print("\n== D1 counts（基线 → 终态） ==")
    drift = {}
    for k, base in BASELINE.items():
        now = final.get(k)
        mark = "OK" if now == base else "DRIFT"
        if now != base:
            drift[k] = (base, now)
        print(f"  {k}: {base} -> {now} [{mark}]")

    r2 = {b: r2_snapshot(b)["count"] for b in ("ciki-assets", "ciki-content")}
    print("== R2 counts（基线 → 终态） ==")
    for b, base in BASELINE_R2.items():
        now = r2[b]
        mark = "OK" if now == base else "DRIFT"
        if now != base:
            drift[f"r2:{b}"] = (base, now)
        print(f"  {b}: {base} -> {now} [{mark}]")

    leftovers = {
        "users": d1_query(DB, "select count(*) n from users where email = ?", ["qa244-embed-icon@ciki-qa.test"])[0]["results"][0]["n"],
        "spaces": d1_query(DB, "select count(*) n from spaces where slug = ?", ["qa244"])[0]["results"][0]["n"],
        "pages": d1_query(DB, "select count(*) n from pages where id = ?", [page_id])[0]["results"][0]["n"],
        "revisions": d1_query(DB, "select count(*) n from page_revisions where page_id = ?", [page_id])[0]["results"][0]["n"],
        "r2_embeds": sum(1 for k in r2_snapshot(BUCKET)["keys"] if k in set(keys)),
    }
    print("== QA 残留（应全为 0） ==")
    for k, v in leftovers.items():
        print(f"  {k}: {v}")

    ok = not drift and all(v == 0 for v in leftovers.values())
    print("\nTEARDOWN", "CLEAN" if ok else f"NOT CLEAN: {drift} {leftovers}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
