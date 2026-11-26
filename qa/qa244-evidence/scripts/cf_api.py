"""Cloudflare API helper for QA (read + explicitly authorized QA seeding/teardown).

Credentials are read from the local wrangler OAuth config at runtime and are
never written to disk or echoed. Run with:
    python3 cf_api.py <subcommand> [args...]
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import urllib.request

ACCOUNT_ID = "967399d1b7212c427f5c032b7f7618f2"
API = "https://api.cloudflare.com/client/v4"


def token() -> str:
    cfg = pathlib.Path.home() / ".wrangler/config/default.toml"
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', cfg.read_text())
    if not m:
        raise SystemExit("no wrangler oauth token found")
    return m.group(1)


def call_raw(method: str, path: str, payload=None) -> dict:
    """Full CF envelope (needed for result_info.pagination.cursor)."""
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:  # surface CF error payloads
        print(f"HTTP {exc.code}: {exc.read().decode()[:800]}", file=sys.stderr)
        raise
    if not body.get("success"):
        print(f"CF error: {json.dumps(body.get('errors'), ensure_ascii=False)[:800]}", file=sys.stderr)
        raise SystemExit(2)
    return body


def call(method: str, path: str, payload=None):
    req = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
        },
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:  # surface CF error payloads
        print(f"HTTP {exc.code}: {exc.read().decode()[:800]}", file=sys.stderr)
        raise
    if not body.get("success"):
        print(f"CF error: {json.dumps(body.get('errors'), ensure_ascii=False)[:800]}", file=sys.stderr)
        raise SystemExit(2)
    return body.get("result")


def d1_query(db_id: str, sql: str, params=None):
    return call(
        "POST",
        f"/accounts/{ACCOUNT_ID}/d1/database/{db_id}/query",
        {"sql": sql, "params": params or []},
    )


def worker_bindings(script: str = "ciki"):
    return call("GET", f"/accounts/{ACCOUNT_ID}/workers/scripts/{script}/settings")


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "bindings":
        print(json.dumps(worker_bindings(), ensure_ascii=False, indent=2)[:4000])
    elif cmd == "query":
        db_id = sys.argv[2]
        sql = sys.argv[3]
        params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
        print(json.dumps(d1_query(db_id, sql, params), ensure_ascii=False))
    elif cmd == "get":
        print(json.dumps(call("GET", sys.argv[2]), ensure_ascii=False))
    else:
        raise SystemExit(f"unknown subcommand {cmd}")


if __name__ == "__main__":
    main()
