"""QA244: seed a temporary QA account + space + page in production Ciki.

Writes (all reversible, teardown deletes them):
  * 1 row in `users`      (QA account, approved + active)
  * 1 row in `sessions`   (session token injected into the browser as a cookie)
  * 1 space + 1 space_members row (via the product's own API)
  * 1 page + revisions    (via the product's own API)

Secrets (session token / password) are written only to /tmp/qa244-state.json
(mode 600), never into the repo.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import secrets
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cf_api import d1_query  # noqa: E402

DB = "af4434ef-c73f-4c69-80b7-56695e6737fe"
BASE = "https://ciki.pama.workers.dev"
STATE = pathlib.Path("/tmp/qa244-state.json")

EMAIL = "qa244-embed-icon@ciki-qa.test"
USERNAME = "qa244-embed-icon"
PASSWORD = "Qa244!" + secrets.token_urlsafe(10)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(32)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000, dklen=32)
    return f"{salt.hex()}:{dk.hex()}"


UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36"
)


def http(method: str, path: str, body=None, token: str | None = None):
    last = None
    for attempt in range(4):
        try:
            return _http_once(method, path, body, token)
        except Exception as exc:  # transient proxy/connection resets
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise last


def _http_once(method: str, path: str, body=None, token: str | None = None):
    data = None
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    if body is not None:
        data = json.dumps(body).encode()
    if token:
        headers["Cookie"] = f"ciki_session={token}"
    req = urllib.request.Request(f"{BASE}{path}", method=method, data=data, headers=headers)
    opener = urllib.request.build_opener()  # honours http(s)_proxy from the environment
    try:
        with opener.open(req, timeout=60) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def main() -> None:
    # Re-runnable: wipe leftovers of a previous QA244 run first.
    stale = d1_query(DB, "select id from users where email = ?", [EMAIL])[0]["results"]
    for row in stale:
        d1_query(DB, "delete from sessions where user_id = ?", [row["id"]])
        d1_query(DB, "delete from users where id = ?", [row["id"]])

    now_iso = "2026-11-26T00:00:00.000Z"
    # Leftover QA spaces/pages from an earlier attempt (identified by slug/name).
    stale_spaces = d1_query(
        DB, "select id from spaces where slug = ? or name = ?", ["qa244", "QA244 图标验收"]
    )[0]["results"]
    for space_row in stale_spaces:
        stale_pages = d1_query(
            DB, "select id from pages where space_id = ?", [space_row["id"]]
        )[0]["results"]
        for page_row in stale_pages:
            d1_query(DB, "delete from page_revisions where page_id = ?", [page_row["id"]])
            d1_query(DB, "delete from pages_fts where rowid = ?", [page_row["id"]])
            d1_query(DB, "delete from pages where id = ?", [page_row["id"]])
        d1_query(DB, "delete from space_members where space_id = ?", [space_row["id"]])
        d1_query(DB, "delete from spaces where id = ?", [space_row["id"]])

    d1_query(
        DB,
        "insert into users (email, password_hash, role, is_active, approval_status,"
        " email_verified, language, username, avatar_key, created_at, updated_at)"
        " values (?,?,?,?,?,?,?,?,?,?,?)",
        [
            EMAIL,
            hash_password(PASSWORD),
            "user",
            1,
            "approved",
            1,
            "zh",
            USERNAME,
            "",
            now_iso,
            now_iso,
        ],
    )
    user_rows = d1_query(DB, "select id from users where email = ?", [EMAIL])[0]["results"]
    user_id = user_rows[0]["id"]

    raw_token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    now_unix = int(__import__("time").time())
    session_id = str(uuid.uuid4())
    d1_query(
        DB,
        "insert into sessions (id, token_hash, user_id, needs_2fa_setup, created_at,"
        " last_seen_at, expires_at, ip, user_agent) values (?,?,?,?,?,?,?,?,?)",
        [
            session_id,
            token_hash,
            user_id,
            0,
            now_unix,
            now_unix,
            now_unix + 7 * 24 * 3600,
            "",
            "qa244",
        ],
    )

    status, me = http("GET", "/api/me", token=raw_token)
    print("GET /api/me ->", status, me if status != 200 else "ok")
    if status != 200:
        raise SystemExit("session injection failed")

    status, space = http(
        "POST",
        "/api/spaces",
        {"name": "QA244 图标验收", "description": "temporary QA space for #244"},
        token=raw_token,
    )
    print("POST /api/spaces ->", status, space)
    if status != 201:
        raise SystemExit("space creation failed")
    space_id = space["id"]

    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "QA244 图标验收页"}],
            }
        ],
    }
    status, page = http(
        "POST",
        "/api/pages",
        {
            "title": "QA244 图标验收页",
            "contentJson": json.dumps(doc, ensure_ascii=False),
            "contentHtml": "<p>QA244 图标验收页</p>",
            "contentText": "QA244 图标验收页",
            "spaceId": space_id,
        },
        token=raw_token,
    )
    print("POST /api/pages ->", status, page)
    if status != 201:
        raise SystemExit("page creation failed")

    state = {
        "email": EMAIL,
        "username": USERNAME,
        "password": PASSWORD,
        "sessionToken": raw_token,
        "sessionId": session_id,
        "userId": user_id,
        "spaceId": space_id,
        "spaceSlug": space.get("slug"),
        "pageId": page["id"],
        "base": BASE,
    }
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    os.chmod(STATE, 0o600)
    print("state written to", STATE)


if __name__ == "__main__":
    main()
