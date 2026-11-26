"""QA244: snapshot production baseline (row counts + R2 object key counts).

Usage:
    python3 baseline.py            # write metrics/baseline.json
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cf_api import ACCOUNT_ID, call_raw, d1_query  # noqa: E402

DB = "af4434ef-c73f-4c69-80b7-56695e6737fe"
OUT = pathlib.Path(__file__).resolve().parents[1] / "metrics" / "baseline.json"

COUNT_SQL = {
    "users": "select count(*) as n from users",
    "spaces": "select count(*) as n from spaces",
    "space_members": "select count(*) as n from space_members",
    "pages_active": "select count(*) as n from pages where deleted_at is null",
    "pages_total": "select count(*) as n from pages",
    "page_revisions": "select count(*) as n from page_revisions",
    "sessions": "select count(*) as n from sessions",
    "api_tokens": "select count(*) as n from api_tokens",
    "comments": "select count(*) as n from comments",
    "notifications": "select count(*) as n from notifications",
}


def counts() -> dict:
    out = {}
    for key, sql in COUNT_SQL.items():
        res = d1_query(DB, sql)
        out[key] = res[0]["results"][0]["n"]
    return out


def r2_snapshot(bucket: str) -> dict:
    """Full key listing; follows result_info.pagination.cursor."""
    keys: list[str] = []
    cursor = ""
    while True:
        path = f"/accounts/{ACCOUNT_ID}/r2/buckets/{bucket}/objects?per_page=1000"
        if cursor:
            path += f"&cursor={cursor}"
        env = call_raw("GET", path)
        keys.extend(o["key"] for o in env["result"])
        info = env.get("result_info") or {}
        cursor = info.get("cursor") or ""
        if not info.get("is_truncated"):
            break
    return {"count": len(keys), "keys": sorted(keys)}


def main() -> None:
    data = {
        "counts": counts(),
        "r2": {
            bucket: {"count": snap["count"]}
            for bucket, snap in ((b, r2_snapshot(b)) for b in ("ciki-assets", "ciki-content"))
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
