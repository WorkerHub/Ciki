"""QA244: precisely remove the 4 orphan content objects this QA run created in
ciki-content (page body blobs outliving the permanently-deleted QA page).

Identification is double-gated:
  1. uploaded timestamp inside this QA run's window (2026-11-26 07:00–07:50 UTC);
  2. gunzipped body mentions the QA marker ("QA244") or one of this run's embed UUIDs.
Only objects matching BOTH are deleted.
"""
from __future__ import annotations

import gzip
import json
import pathlib
import sys
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from baseline import ACCOUNT_ID, r2_snapshot  # noqa: E402
from cf_api import call_raw, token  # noqa: E402

BUCKET = "ciki-content"
WINDOW_START = "2026-11-26T07:25:00"
WINDOW_END = "2026-11-26T07:45:00"
MARKERS = ("QA244", "qa244-sample.html", "09aa3af7", "317232c4", "85b81153")


def list_objects() -> list[dict]:
    """Full listing with metadata (uploaded timestamps)."""
    out: list[dict] = []
    cursor = ""
    while True:
        path = f"/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects?per_page=1000"
        if cursor:
            path += f"&cursor={cursor}"
        env = call_raw("GET", path)
        out.extend(env["result"])
        info = env.get("result_info") or {}
        cursor = info.get("cursor") or ""
        if not info.get("is_truncated"):
            break
    return out


def get_object_bytes(key: str) -> bytes:
    """GET 对象本体（gzip 原始字节，非 JSON 包裹）。"""
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects/{key}",
        headers={"Authorization": f"Bearer {token()}"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=60) as resp:
        return resp.read()


def main() -> None:
    dry = "--apply" not in sys.argv
    objs = list_objects()
    print("total objects:", len(objs))

    candidates = []
    for o in objs:
        up = o.get("last_modified", "")
        if WINDOW_START <= up <= WINDOW_END:
            candidates.append(o)
    print("in-window candidates:", len(candidates))
    for o in candidates:
        print("  ", o["key"], o["last_modified"], o.get("size"))

    # 内容验证（第二个闸门）：GET 对象返回 gzip 原始字节，需直读
    confirmed = []
    for o in candidates:
        key = o["key"]
        raw = get_object_bytes(key)
        try:
            text = gzip.decompress(raw).decode("utf-8", "replace")
        except Exception:
            text = raw.decode("utf-8", "replace")
        hit = any(m in text for m in MARKERS)
        print(f"  content check {key}: {'QA-MARKED' if hit else 'no-marker'} (len={len(text)})")
        if hit:
            confirmed.append(key)

    print("confirmed orphans:", len(confirmed))
    if dry:
        print("DRY RUN — rerun with --apply to delete.")
        return

    for key in confirmed:
        env = call_raw("DELETE", f"/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects/{key}")
        print("deleted", key, "->", "ok" if env.get("success") else env.get("errors"))

    snap = r2_snapshot(BUCKET)
    print("ciki-content count now:", snap["count"])
    json.dump(snap["keys"], open(pathlib.Path(__file__).parent.parent / "metrics" / "ciki-content-keys-after.json", "w"))


if __name__ == "__main__":
    main()
