/**
 * 铸造两个 QA 主人账号 + 各自令牌（只写生产 D1 的 users / api_tokens 两张表）。
 * 明文令牌只写到 /tmp/qa243/tokens.env（chmod 600），不进仓库、不进报告。
 */
const crypto = require("node:crypto")
const fs = require("node:fs")
const { execFileSync } = require("node:child_process")

const D1Q = "/tmp/qa243/d1q.sh"

function d1(sql, params = []) {
  const out = execFileSync(D1Q, [sql, JSON.stringify(params)], {
    encoding: "utf8"
  })
  const parsed = JSON.parse(out)
  if (!parsed.success) throw new Error("D1 failed: " + JSON.stringify(parsed.errors))
  return parsed.result[0]
}

const randomToken = () =>
  crypto.randomBytes(32).toString("base64url").replace(/=+$/, "")
const sha256Hex = (s) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex")
const hashPassword = (password) => {
  const salt = crypto.randomBytes(32)
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256")
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}

const now = new Date().toISOString()
const pwdA = hashPassword(crypto.randomBytes(24).toString("hex"))
const pwdB = hashPassword(crypto.randomBytes(24).toString("hex"))

const users = [
  { email: "qa243a@qa.test", username: "qa243_owner_a", pwd: pwdA },
  { email: "qa243b@qa.test", username: "qa243_owner_b", pwd: pwdB }
]

const userIds = {}
for (const u of users) {
  const res = d1(
    `INSERT INTO users (email, password_hash, role, is_active, approval_status,
       email_verified, language, username, avatar_key, kind, owner_user_id, created_at, updated_at)
     VALUES (?, ?, 'user', 1, 'approved', 1, 'zh', ?, '', 'human', NULL, ?, ?)`,
    [u.email, u.pwd, u.username, now, now]
  )
  userIds[u.username] = res.meta.last_row_id
  console.log(`minted user ${u.email} id=${res.meta.last_row_id}`)
}

const tokens = {
  A_WRITE: randomToken(),
  A_READ: randomToken(),
  B_WRITE: randomToken(),
  B_READ: randomToken()
}
const tokenRows = [
  { k: "A_WRITE", user: "qa243_owner_a", kind: "write", name: "qa243-write-a" },
  { k: "A_READ", user: "qa243_owner_a", kind: "read", name: "qa243-read-a" },
  { k: "B_WRITE", user: "qa243_owner_b", kind: "write", name: "qa243-write-b" },
  { k: "B_READ", user: "qa243_owner_b", kind: "read", name: "qa243-read-b" }
]
for (const t of tokenRows) {
  d1(
    `INSERT INTO api_tokens (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    [userIds[t.user], t.kind, t.name, sha256Hex(tokens[t.k]), now]
  )
}

fs.writeFileSync(
  "/tmp/qa243/tokens.env",
  Object.entries(tokens)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n") + "\n",
  { mode: 0o600 }
)
fs.writeFileSync(
  "/tmp/qa243/user-ids.env",
  Object.entries(userIds)
    .map(([k, v]) => `export UID_${k.toUpperCase()}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600 }
)
console.log("tokens written to /tmp/qa243/tokens.env (mode 600)")
