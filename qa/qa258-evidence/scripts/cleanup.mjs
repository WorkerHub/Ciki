// QA258 生产测试数据拆除 + 与基线对账
import { d1, d1exec, r2delete, r2list } from "./cf.mjs"
import fs from "node:fs"

const DB = "af4434ef-c73f-4c69-80b7-56695e6737fe"
const BASE = "https://ciki.oneboy.app"
const baseline = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/baseline.json", "utf8"))
const snap = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/snap-now.json", "utf8"))
const QA_USER_IDS = snap.qaUsers.map((u) => u.id)
const QA_SPACE_ID = snap.qaSpace[0].id
const QA_PAGE_ID = snap.qaPages[0].id
const q = async (sql, params = []) => (await d1(DB, sql, params))[0] ?? {}

// 先记录 auth_counters 全量（判断是否需要清理 write:<uid> 行）
const acBefore = await d1(DB, "SELECT key, action, count FROM auth_counters")
console.log(`auth_counters 行数（拆前）: ${acBefore.length}`)
console.log("  write:<uid> 相关:", JSON.stringify(acBefore.filter((r) => QA_USER_IDS.some((id) => String(r.key).includes(String(id))))))

const steps = []
async function del(label, sql, params = []) {
  const before = await q(sql.replace("DELETE FROM", "SELECT COUNT(*) AS c FROM"), params)
  const res = await d1exec(DB, [{ sql, params }])
  const after = await q(sql.replace("DELETE FROM", "SELECT COUNT(*) AS c FROM"), params)
  steps.push({ label, sql, before: before.c, after: after.c, meta: res })
  console.log(`  ${label}: ${before.c} → ${after.c}`)
}

// 1) 通知（接收者是 QA 账号）
await del("notifications(recipient in QA)", "DELETE FROM notifications WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')")
// 2) 评论（QA 页上的 QA 评论）
await del("comments(QA page)", "DELETE FROM comments WHERE page_id = ?", [QA_PAGE_ID])
// 3) 页面修订
await del("page_revisions(QA page)", "DELETE FROM page_revisions WHERE page_id = ?", [QA_PAGE_ID])
// 4) FTS 行（按 page_id 列，不能按 rowid）
await del("pages_fts(QA page)", "DELETE FROM pages_fts WHERE page_id = ?", [QA_PAGE_ID])
// 5) 页面
await del("pages(QA page)", "DELETE FROM pages WHERE id = ?", [QA_PAGE_ID])
// 6) 空间成员
await del("space_members(QA space)", "DELETE FROM space_members WHERE space_id = ?", [QA_SPACE_ID])
// 7) 空间
await del("spaces(QA space)", "DELETE FROM spaces WHERE id = ?", [QA_SPACE_ID])
// 8) 会话
await del("sessions(QA users)", "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')")
// 9) API 令牌（若有）
await del("api_tokens(QA users)", "DELETE FROM api_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')")
// 10) 导入令牌（若有）
await del("import_tokens(QA users)", "DELETE FROM import_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')")
// 11) 用户
await del("users(QA)", "DELETE FROM users WHERE email LIKE '%qa258%'")

// R2：只删本次铸造的 key（与基线快照精确比对得出）
const newAssets = snap.assets.filter((k) => !baseline.assets.includes(k))
const newContents = snap.contents.filter((k) => !baseline.content.includes(k))
for (const k of newAssets) { const s = await r2delete("ciki-assets", k); console.log(`  R2 assets 删除 ${k} -> ${s}`) }
for (const k of newContents) { const s = await r2delete("ciki-content", k); console.log(`  R2 content 删除 ${k} -> ${s}`) }

// 终态核对
const counts = {
  users: (await q("SELECT COUNT(*) AS c FROM users")).c,
  spaces: (await q("SELECT COUNT(*) AS c FROM spaces")).c,
  space_members: (await q("SELECT COUNT(*) AS c FROM space_members")).c,
  pages: (await q("SELECT COUNT(*) AS c FROM pages")).c,
  pages_active: (await q("SELECT COUNT(*) AS c FROM pages WHERE deleted_at IS NULL")).c,
  comments: (await q("SELECT COUNT(*) AS c FROM comments")).c,
  notifications: (await q("SELECT COUNT(*) AS c FROM notifications")).c,
  sessions: (await q("SELECT COUNT(*) AS c FROM sessions")).c,
  api_tokens: (await q("SELECT COUNT(*) AS c FROM api_tokens")).c,
  page_revisions: (await q("SELECT COUNT(*) AS c FROM page_revisions")).c,
  import_tokens: (await q("SELECT COUNT(*) AS c FROM import_tokens")).c,
  pages_fts: (await q("SELECT COUNT(*) AS c FROM pages_fts")).c
}
const residual = {
  qaUsers: await d1(DB, "SELECT id, email FROM users WHERE email LIKE '%qa258%'"),
  qaSpaces: await d1(DB, "SELECT id, name FROM spaces WHERE name LIKE '%QA258%'"),
  qaPages: await d1(DB, "SELECT id, title FROM pages WHERE title LIKE '%QA258%'"),
  qaComments: await d1(DB, "SELECT id, body_md FROM comments WHERE body_md LIKE '%QA258%'"),
  qaNotifications: await d1(DB, "SELECT id FROM notifications WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')"),
  qaSessions: await d1(DB, "SELECT id FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%qa258%')"),
  qaMembers: await d1(DB, "SELECT * FROM space_members WHERE space_id = ?", [QA_SPACE_ID]),
  qaRevisions: await q1("SELECT COUNT(*) AS c FROM page_revisions WHERE page_id = ?", [QA_PAGE_ID]),
  qaFts: await d1(DB, "SELECT COUNT(*) AS c FROM pages_fts WHERE page_id = ?", [QA_PAGE_ID]),
  orphanFts: await d1(DB, "SELECT COUNT(*) AS c FROM pages_fts WHERE page_id NOT IN (SELECT id FROM pages)"),
  orphanRevisions: await d1(DB, "SELECT COUNT(*) AS c FROM page_revisions WHERE page_id NOT IN (SELECT id FROM pages)"),
  orphanMembers: await d1(DB, "SELECT COUNT(*) AS c FROM space_members WHERE user_id NOT IN (SELECT id FROM users)"),
  orphanSessions: await d1(DB, "SELECT COUNT(*) AS c FROM sessions WHERE user_id NOT IN (SELECT id FROM users)"),
  orphanComments: await d1(DB, "SELECT COUNT(*) AS c FROM comments WHERE author_id NOT IN (SELECT id FROM users)"),
  orphanNotifs: await d1(DB, "SELECT COUNT(*) AS c FROM notifications WHERE recipient_id NOT IN (SELECT id FROM users)")
}
async function q1(sql, params) { const r = await d1(DB, sql, params); return r[0] ?? {} }

const acAfter = await d1(DB, "SELECT key, action, count FROM auth_counters")
const assetsAfter = await r2list("ciki-assets")
const contentsAfter = await r2list("ciki-content")
const assetDiff = { added: assetsAfter.filter((k) => !baseline.assets.includes(k)), removed: baseline.assets.filter((k) => !assetsAfter.includes(k)) }
const contentDiff = { added: contentsAfter.filter((k) => !baseline.content.includes(k)), removed: baseline.content.filter((k) => !contentsAfter.includes(k)) }

// 已删账号登录应 401
const deadLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "qa258-admin@example.com", password: "QA258-Placeholder-Pass!" }) })
const deadLoginBody = await deadLogin.text()

const cmp = {}
for (const k of Object.keys(baseline.counts)) cmp[k] = { base: baseline.counts[k], now: counts[k], same: baseline.counts[k] === counts[k] }
console.log("\n--- 与基线对账 ---")
for (const [k, v] of Object.entries(cmp)) console.log(`  ${k}: 基线 ${v.base} / 现在 ${v.now} ${v.same ? "✅" : "❌"}`)
console.log(`  pages_fts: 基线未记录 / 现在 ${counts.pages_fts}（QA FTS 行已删，孤儿 ${residual.orphanFts} 条）`)
console.log("\n--- 残留检查 ---")
console.log(JSON.stringify(residual, null, 1))
console.log(`\nR2 assets 差集: ${JSON.stringify(assetDiff)}`)
console.log(`R2 content 差集: ${JSON.stringify(contentDiff)}`)
console.log(`auth_counters 行数 拆前 ${acBefore.length} / 拆后 ${acAfter.length}`)
console.log(`已删账号登录返回: ${deadLogin.status} ${deadLoginBody.slice(0, 120)}`)

fs.writeFileSync("/tmp/ciki-qa258-prod/cleanup-result.json", JSON.stringify({ at: new Date().toISOString(), steps, counts, baseline: baseline.counts, cmp, residual, assetDiff, contentDiff, authCountersBefore: acBefore.length, authCountersAfter: acAfter.length, deadLogin: { status: deadLogin.status, body: deadLoginBody.slice(0, 200) }, newAssets, newContents }, null, 1))
