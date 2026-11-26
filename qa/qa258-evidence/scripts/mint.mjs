// QA258 生产铸数：3 个账号（管理员 / 成员 / 预置 distill 账号）+ 空间 + 页面 + 资产 + 评论
// 纪律：口令与令牌只落在本地 state.json（0600），不进任何证据文件
import { d1, d1exec, hashPassword, uuid, randB64url, sha256hex } from "./cf.mjs"
import fs from "node:fs"

const DB = "af4434ef-c73f-4c69-80b7-56695e6737fe"
const BASE = "https://ciki.oneboy.app"
const PW = process.env.QA_PROD_PASSWORD // 口令只走环境变量，不入库

const USERS = [
  { key: "admin", email: "qa258-admin@example.com", username: "qa258admin", role: "admin", theme: "nova" },
  { key: "author", email: "qa258-author@example.com", username: "qa258author", role: "user", theme: "nova" },
  { key: "distill", email: "qa258-distill@example.com", username: "qa258distill", role: "user", theme: "distill" }
]

const now = new Date().toISOString()
const state = { base: BASE, db: DB, users: {}, spaces: [], pages: [], assets: {}, password: PW }

// ---------- 1. 用户 + 会话 ----------
const existing = await d1(DB, `select email from users where email in (${USERS.map(() => "?").join(",")})`, USERS.map(u => u.email))
if (existing.length) throw new Error(`邮箱已存在，先清理：${existing.map(e => e.email).join(",")}`)

const stmts = []
for (const u of USERS) {
  stmts.push({
    sql: `insert into users (email, password_hash, role, is_active, approval_status, email_verified, language, username, avatar_key, created_at, updated_at, kind, owner_user_id, bio, theme_style)
          values (?,?,?,1,'approved',1,'zh',?,'',?,?,'human',null,'',?)`,
    params: [u.email, hashPassword(PW), u.role, u.username, now, now, u.theme]
  })
}
for (const u of USERS) {
  const token = randB64url(32)
  const ts = Math.floor(Date.now() / 1000)
  stmts.push({
    sql: `insert into sessions (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
          values (?,?,(select id from users where email=?),0,?,?,?,'public-ip-qa258','QA258/1.0')`,
    params: [uuid(), sha256hex(token), u.email, ts, ts, ts + 7 * 24 * 3600]
  })
  u.token = token
}
await d1exec(DB, stmts)

const rows = await d1(DB, `select id, email from users where email in (${USERS.map(() => "?").join(",")})`, USERS.map(u => u.email))
for (const u of USERS) {
  const r = rows.find(x => x.email === u.email)
  if (!r) throw new Error(`用户未插入：${u.email}`)
  u.id = r.id
  state.users[u.key] = { id: u.id, email: u.email, role: u.role, seededTheme: u.theme, token: u.token }
}

// ---------- 2. API 辅助 ----------
async function api(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { ...headers }
  if (cookie) h.Cookie = `ciki_session=${cookie}`
  if (body !== undefined && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json"
    body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body })
  const txt = await res.text()
  let json
  try { json = JSON.parse(txt) } catch { json = { raw: txt.slice(0, 300) } }
  return { status: res.status, json }
}
state.api = api

const A = USERS[0].token
const B = USERS[1].token
const C = USERS[2].token

// ---------- 3. 空间 + 成员 ----------
const spaceName = "QA258 六风格矩阵"
const sp = await api("/api/spaces", { method: "POST", cookie: A, body: { name: spaceName, description: "QA258 6 风格 × 2 模式生产验收样本" } })
if (sp.status !== 200 && sp.status !== 201) throw new Error(`建空间失败 ${sp.status} ${JSON.stringify(sp.json).slice(0, 200)}`)
const spaceId = sp.json.space?.id ?? sp.json.id
if (!spaceId) throw new Error(`空间 id 未取得：${JSON.stringify(sp.json).slice(0, 200)}`)
state.spaces.push({ id: spaceId, name: spaceName })

for (const [uid, role] of [[USERS[1].id, "editor"], [USERS[2].id, "viewer"]]) {
  const r = await api(`/api/spaces/${spaceId}/members`, { method: "POST", cookie: A, body: { userId: uid, role } })
  if (r.status !== 200 && r.status !== 201) throw new Error(`加成员 ${uid} 失败 ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
}

// ---------- 4. 资产上传 ----------
async function uploadFile(path, fileName, bytes, contentType) {
  const fd = new FormData()
  fd.append("file", new Blob([bytes], { type: contentType }), fileName)
  const r = await api(path, { method: "POST", cookie: A, body: fd })
  if (r.status !== 200 && r.status !== 201) throw new Error(`上传 ${fileName} 失败 ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
  return r.json
}
const sceneBytes = fs.readFileSync("/tmp/ciki-qa258/scene.json")
const previewBytes = fs.readFileSync("/tmp/ciki-qa258/preview.png")
const probeBytes = fs.readFileSync("/tmp/ciki-qa258-prod/probe-6style.html")
const bareBytes = fs.readFileSync("/tmp/ciki-qa258-prod/probe-bare.html")

const scene = await uploadFile("/api/files", "qa258-scene.json", sceneBytes, "application/json")
const preview = await uploadFile("/api/files", "qa258-preview.png", previewBytes, "image/png")
const probe = await uploadFile("/api/files/embeds", "qa258-probe.html", probeBytes, "text/html")
const bare = await uploadFile("/api/files/embeds", "qa258-bare.html", bareBytes, "text/html")
state.assets = { scene: scene.key, preview: preview.key, probe: probe.key, bare: bare.key }

// ---------- 5. 页面（正文用本地已验证 contentJson，替换生产 key） ----------
const local = JSON.parse(fs.readFileSync("/tmp/ciki-qa258/page1.json", "utf8"))
const doc = JSON.parse(local.contentJson)
for (const node of doc.content) {
  if (node.type === "excalidraw") {
    node.attrs.sceneKey = scene.key
    node.attrs.previewKey = preview.key
  }
  if (node.type === "htmlEmbed") {
    node.attrs.key = probe.key
    node.attrs.name = "QA258 embed probe"
  }
  if (node.type === "paragraph") {
    for (const t of node.content || []) if (t.text === "学术链接探针") t.text = "链接探针"
  }
}
const contentJson = JSON.stringify(doc)
// 用生产 main 同款渲染器生成 HTML/纯文本
// （/tmp/ciki-qa258/base 与生产 clone 的 tiptap-html.ts / sanitize.ts 逐字相同）
const { execFileSync } = await import("node:child_process")
const tmpDoc = "/tmp/ciki-qa258-prod/page-doc.json"
fs.writeFileSync(tmpDoc, JSON.stringify({ title: "QA258 主题全矩阵主样本", contentJson }))
execFileSync("node", ["/tmp/ciki-qa258/render-entry.bundle.cjs", tmpDoc], { encoding: "utf8" })
const renderedDoc = JSON.parse(fs.readFileSync(tmpDoc + ".rendered.json", "utf8"))
const pagePayload = {
  spaceId,
  title: "QA258 主题全矩阵主样本",
  contentJson,
  contentHtml: renderedDoc.contentHtml,
  contentText: renderedDoc.contentText
}
const pageRes = await api("/api/pages", { method: "POST", cookie: A, body: pagePayload })
if (pageRes.status !== 200 && pageRes.status !== 201) {
  throw new Error(`建页失败 ${pageRes.status} ${JSON.stringify(pageRes.json).slice(0, 300)}`)
}
const pageId = pageRes.json.page?.id ?? pageRes.json.id
state.pages.push({ id: pageId, title: pagePayload.title, spaceId })

// ---------- 6. 评论（成员 B 发两条 → 页面创建者 A 收到通知） ----------
const comments = ["QA258-COMMENT-1 生产评论区探针首评", "QA258-COMMENT-2 生产评论区探针二评"]
for (const bodyMd of comments) {
  const r = await api(`/api/pages/${pageId}/comments`, { method: "POST", cookie: B, body: { bodyMd } })
  if (r.status !== 200 && r.status !== 201) throw new Error(`评论失败 ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
}

// ---------- 7. 终态自检 ----------
const check = await api("/api/me", { cookie: A })
const meDistill = await api("/api/me", { cookie: C })
const notes = await api("/api/notifications", { cookie: A })
state.selfCheck = {
  adminThemeStyle: check.json.themeStyle,
  distillAccountMe: { status: meDistill.status, themeStyle: meDistill.json.themeStyle },
  notifications: Array.isArray(notes.json) ? notes.json.length : (notes.json.notifications?.length ?? null)
}

fs.writeFileSync("/tmp/ciki-qa258-prod/state.json", JSON.stringify(state, null, 1), { mode: 0o600 })
console.log("铸数完成：")
console.log("  users:", USERS.map(u => `${u.key}=${u.id}`).join(", "))
console.log("  space:", spaceId, " page:", pageId)
console.log("  assets:", JSON.stringify(state.assets))
console.log("  selfCheck:", JSON.stringify(state.selfCheck))
