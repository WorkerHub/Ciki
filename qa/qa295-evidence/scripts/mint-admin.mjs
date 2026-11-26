/**
 * QA #295 铸造临时 QA 管理员（只往生产 D1 users 表写一行）。
 *
 * 口令随机生成、只落到 QA_ENV 文件（chmod 600），不进仓库、不回显。
 * 测后由 teardown.sh 精确删除该 uid 及其 sessions。
 *
 * 用法：
 *   export QA_ENV=/tmp/qa295/qa.env
 *   export QA_D1Q=/tmp/qa295/d1q.sh
 *   node mint-admin.mjs
 */
import crypto from "node:crypto"
import fs from "node:fs"
import { execFileSync } from "node:child_process"

const D1Q = process.env.QA_D1Q || "/tmp/qa295/d1q.sh"
const ENV_FILE = process.env.QA_ENV || "/tmp/qa295/qa.env"
const QA_EMAIL = process.env.QA_EMAIL_FIXTURE || "qa295admin@qa.test"
const QA_USERNAME = process.env.QA_USERNAME_FIXTURE || "qa295_admin"

function d1(sql, params = []) {
  const out = execFileSync(D1Q, [sql, JSON.stringify(params)], { encoding: "utf8" })
  const parsed = JSON.parse(out)
  if (!parsed.success) throw new Error("D1 failed: " + JSON.stringify(parsed.errors))
  return parsed.result[0]
}

const hashPassword = (password) => {
  const salt = crypto.randomBytes(32)
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256")
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}

const now = new Date().toISOString()
const password = crypto.randomBytes(16).toString("hex")

// 基线快照（清理核验用）
fs.writeFileSync(
  process.env.QA_BASELINE || "/tmp/qa295/baseline-users.json",
  JSON.stringify(
    d1(
      `SELECT id, email, username, kind, role, is_active, approval_status,
              owner_user_id, email_verified, language, created_at
         FROM users ORDER BY id`
    ).results,
    null,
    2
  ),
  { mode: 0o600 }
)

const res = d1(
  `INSERT INTO users (email, password_hash, role, is_active, approval_status,
     email_verified, language, username, avatar_key, kind, owner_user_id,
     bio, theme_style, created_at, updated_at)
   VALUES (?, ?, 'admin', 1, 'approved', 1, 'zh', ?, '', 'human', NULL, '', 'nova', ?, ?)`,
  [QA_EMAIL, hashPassword(password), QA_USERNAME, now, now]
)
const uid = res.meta.last_row_id

fs.writeFileSync(
  ENV_FILE,
  `export QA_UID=${uid}\nexport QA_EMAIL="${QA_EMAIL}"\nexport QA_USERNAME="${QA_USERNAME}"\nexport QA_PASSWORD="${password}"\n`,
  { mode: 0o600 }
)
console.log(`minted QA admin uid=${uid} (username=${QA_USERNAME})`)
console.log(`password stored in ${ENV_FILE} (mode 600)`)
