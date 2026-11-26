/**
 * QA254 铸造：两个 QA 主人账号 + write 令牌 + 会话（生产 D1 users/api_tokens/sessions 三表）。
 * 明文令牌/会话只写 /tmp/qa254/tokens.env（chmod 600），不进仓库、不进报告、不回显。
 * 幂等防护：已存在同名账号则直接失败（不覆盖任何行）。
 */
const crypto = require("node:crypto")
const fs = require("node:fs")
const { execFileSync } = require("node:child_process")

const D1Q = "/tmp/qa254/scripts/d1q.sh"

function d1(sql, params = []) {
  const out = execFileSync(D1Q, [sql, JSON.stringify(params)], {
    encoding: "utf8"
  })
  const parsed = JSON.parse(out)
  if (!parsed.success)
    throw new Error("D1 failed: " + JSON.stringify(parsed.errors))
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

// 预检：同前缀账号必须不存在，防止重复铸造
const pre = d1(
  `SELECT COUNT(*) AS n FROM users WHERE email LIKE 'qa254%@qa.test' OR username LIKE 'qa254_%'`
)
if (pre.results[0].n !== 0) {
  throw new Error(`qa254 账号已存在 ${pre.results[0].n} 行，拒绝重复铸造`)
}

const now = new Date().toISOString()
const pwdA = hashPassword(crypto.randomBytes(24).toString("hex"))
const pwdB = hashPassword(crypto.randomBytes(24).toString("hex"))

const users = [
  { email: "qa254a@qa.test", username: "qa254_owner_a", pwd: pwdA },
  { email: "qa254b@qa.test", username: "qa254_owner_b", pwd: pwdB }
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

// write 令牌（/api/write/* 建页软删用）
const tokens = { A_WRITE: randomToken(), B_WRITE: randomToken() }
const tokenRows = [
  { k: "A_WRITE", user: "qa254_owner_a", name: "qa254-write-a" },
  { k: "B_WRITE", user: "qa254_owner_b", name: "qa254-write-b" }
]
for (const t of tokenRows) {
  d1(
    `INSERT INTO api_tokens (user_id, kind, name, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, 'write', ?, ?, ?, NULL, NULL)`,
    [userIds[t.user], t.name, sha256Hex(tokens[t.k]), now]
  )
}

// 会话（/api/pages/*、/api/spaces/* 会话 Cookie 鉴权用）
const sessions = { A_SESSION: randomToken(), B_SESSION: randomToken() }
for (const [k, username] of [
  ["A_SESSION", "qa254_owner_a"],
  ["B_SESSION", "qa254_owner_b"]
]) {
  const nowSec = Math.floor(Date.now() / 1000)
  d1(
    `INSERT INTO sessions (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, 0, ?, ?, ?, '', 'qa254-minted')`,
    [
      crypto.randomUUID(),
      sha256Hex(sessions[k]),
      userIds[username],
      nowSec,
      nowSec,
      nowSec + 60 * 60 * 24
    ]
  )
}

fs.writeFileSync(
  "/tmp/qa254/tokens.env",
  Object.entries({ ...tokens, ...sessions })
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n") +
    "\n" +
    Object.entries(userIds)
      .map(([k, v]) => `export UID_${k.toUpperCase()}=${v}`)
      .join("\n") +
    "\n",
  { mode: 0o600 }
)
console.log("tokens/sessions written to /tmp/qa254/tokens.env (mode 600)")
