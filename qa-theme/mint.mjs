#!/usr/bin/env node
// Ciki 主题全矩阵 QA —— 铸数：QA 用户 ×2、空间、汇流页（代码/表格/画布/Embed）、评论与通知
// 纪律：只新增本单自己的数据；不动 qa234 等既有数据；所有 id/key/token 落 state.json。
import { execSync } from "node:child_process"
import { writeFileSync, readFileSync } from "node:fs"
import { createHash, randomBytes, pbkdf2Sync } from "node:crypto"
import { deflateSync } from "node:zlib"
import { Api, BASE, clean } from "./lib.mjs"

const EMAIL_A = "qa-nat-a@qa.local" // 用户 A：作者 + 管理员
const EMAIL_B = "qa-nat-b@qa.local" // 用户 B：评论者
const HOSTNAME = "qa.local" // 既有 QA 域名（仅记录用途）
const QA_MARK = "QA主题全矩阵"

function wrangler(sql) {
  // 单引号安全包裹：SQL 内单引号写成 '\''，真实换行原样保留（双引号+JSON.stringify 会把
  // 换行留在 \n 两字符，SQLite 报 unrecognized token "\"）。
  const quoted = "'" + sql.replace(/'/g, "'\\''") + "'"
  const cmd = `npx --yes wrangler d1 execute ciki --remote --json --command ${quoted}`
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const out = execSync(cmd, {
        cwd: "/tmp",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024
      }).toString()
      const j = JSON.parse(out.slice(out.indexOf("[")))
      return j[0].results
    } catch (err) {
      const stdout = err.stdout ? err.stdout.toString() : ""
      const transient = /failed|401|429|5[0-9][0-9]|timeout|refresh/i.test(
        stdout + String(err.message ?? "")
      )
      if (stdout.includes('"error"')) {
        writeFileSync(
          new URL("./evidence/last-wrangler-error.json", import.meta.url),
          stdout
        )
      }
      if (attempt < 4 && transient) {
        const wait = attempt * 8000
        console.error(`wrangler attempt ${attempt} failed, retry in ${wait}ms`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
        continue
      }
      throw err
    }
  }
}

function hashPassword(password) {
  const salt = randomBytes(32)
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256")
  return `${salt.toString("hex")}:${hash.toString("hex")}`
}
function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex")
}

// ── 极小 PNG 编码器（64×64，双色斜分） ──────────────────────────
function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng() {
  const W = 64, H = 64
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8bit RGB
  const rows = []
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3)
    for (let x = 0; x < W; x++) {
      const ink = x + y < W // 左上三角墨色，右下米纸色
      row[1 + x * 3] = ink ? 0x5f : 0xfa
      row[2 + x * 3] = ink ? 0x70 : 0xf6
      row[3 + x * 3] = ink ? 0x50 : 0xf1
    }
    rows.push(row)
  }
  const idat = deflateSync(Buffer.concat(rows))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ])
}

// ── QA 资产 ─────────────────────────────────────────────────────
const sceneJson = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "ciki-qa",
  elements: [
    {
      id: "qa-rect-1", type: "rectangle", x: 80, y: 80, width: 220, height: 120,
      angle: 0, strokeColor: "#5f7050", backgroundColor: "#c3cfb2",
      fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
      opacity: 100, roundness: null, groupIds: [], frameId: null, locked: false,
      boundElements: null
    },
    {
      id: "qa-ellipse-1", type: "ellipse", x: 360, y: 100, width: 160, height: 160,
      angle: 0, strokeColor: "#292524", backgroundColor: "#e9e0d4",
      fillStyle: "hachure", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
      opacity: 100, roundness: null, groupIds: [], frameId: null, locked: false,
      boundElements: null
    },
    {
      id: "qa-text-1", type: "text", x: 110, y: 320, width: 300, height: 25,
      angle: 0, strokeColor: "#292524", backgroundColor: "transparent",
      fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
      opacity: 100, roundness: null, groupIds: [], frameId: null, locked: false,
      boundElements: null,
      text: "QA 画布：矩形与圆形", originalText: "QA 画布：矩形与圆形",
      fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top",
      baseline: 18, lineHeight: 1.25, containerId: null, autoResize: true
    }
  ],
  appState: { viewBackgroundColor: "#faf6f1", gridSize: null }
})

// Embed 探针：读 URL 参数 + 监听 ciki-embed-theme（照 agent-guide 第 6 节契约对接）
const embedHtml = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>QA THEME PROBE</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, sans-serif;
    padding: 18px 22px; box-sizing: border-box; min-height: 330px;
    transition: none;
  }
  /* 真值表四风格八组底/字色（agent-guide §7 同源） */
  body { background: #ffffff; color: oklch(0.145 0 0); }
  html.dark body { background: oklch(0.145 0 0); color: oklch(0.985 0 0); }
  html[data-theme="paper"] body { background: #f7f4ee; color: #2a2b2f; }
  html[data-theme="paper"].dark body { background: #0b0c0e; color: #f2f0eb; }
  html[data-theme="natural"] body { background: #faf6f1; color: #292524; }
  html[data-theme="natural"].dark body { background: #191612; color: #ece7dd; }
  html[data-theme="eink"] body { background: #f5f3ea; color: #20211e; }
  html[data-theme="eink"].dark body { background: #171814; color: #eceade; }
  h1 { font-size: 15px; margin: 0 0 10px; letter-spacing: .04em; }
  .row { font: 13px/1.7 ui-monospace, monospace; white-space: nowrap; }
  #chip {
    margin-top: 12px; display: inline-block; padding: 7px 16px; border-radius: 8px;
    font: 600 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    background: oklch(0.205 0 0); color: oklch(0.985 0 0);
  }
  html[data-theme="paper"] #chip { background: #e2705a; color: #ffffff; }
  html[data-theme="paper"].dark #chip { background: #e8694e; color: #ffffff; }
  html[data-theme="natural"] #chip { background: #5f7050; color: #ffffff; }
  html[data-theme="natural"].dark #chip { background: #a3b18a; color: #1c2317; }
  html[data-theme="eink"] #chip { background: #20211e; color: #f5f3ea; }
  html[data-theme="eink"].dark #chip { background: #eceade; color: #171814; }
</style>
</head>
<body>
<h1>QA THEME PROBE</h1>
<div class="row" id="url-line">url: …</div>
<div class="row" id="msg-line">msg: (none yet)</div>
<div class="row" id="msg-count">messages: 0</div>
<div id="chip">primary chip</div>
<script>
// —— agent-guide §6 契约的作者侧实现（照文档示例）——
function apply(mode, style) {
  var de = document.documentElement
  de.setAttribute("data-theme", style)
  de.classList.toggle("dark", mode === "dark")
  window.__qaLast = { mode: mode, style: style }
}
(function () {
  var p = new URLSearchParams(location.search)
  document.getElementById("url-line").textContent =
    "url-mode=" + p.get("mode") + " url-style=" + p.get("style")
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || data.type !== "ciki-embed-theme") return
    apply(data.mode, data.style)
    document.getElementById("msg-line").textContent =
      "msg-mode=" + data.mode + " msg-style=" + data.style
    var c = document.getElementById("msg-count")
    c.textContent = "messages: " + ((+((c.textContent.match(/\\d+/) || [0])[0])) + 1)
  })
  window.parent.postMessage({ type: "qa-probe-ready" }, "*")
})()
</script>
</body>
</html>
`

// ── 0. 基线快照 ─────────────────────────────────────────────────
const before = wrangler(
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM spaces) AS spaces, (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS pages_active, (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM notifications) AS notifications, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM api_tokens) AS api_tokens, (SELECT COUNT(*) FROM import_tokens) AS import_tokens"
)[0]
console.error("baseline:", JSON.stringify(before))

const state = {
  startedAt: new Date().toISOString(),
  baseline: before,
  emails: { A: EMAIL_A, B: EMAIL_B },
  uploads: [],
  notes: []
}

// ── 1. 铸用户（approved+active；A 直接 admin） ───────────────────
const passwordA = "Qa-" + randomBytes(12).toString("base64url")
const passwordB = "Qa-" + randomBytes(12).toString("base64url")
// 与现网一致：ISO 带毫秒带 Z
const ts = new Date().toISOString()

const users = wrangler(
  `SELECT id, email FROM users WHERE email IN ('${EMAIL_A}', '${EMAIL_B}')`
)
if (users.length) {
  console.error("QA users already exist:", JSON.stringify(users))
  process.exit(2)
}
const mkUser = (email, username, password, role) => {
  wrangler(
    `INSERT INTO users (email, password_hash, role, is_active, approval_status, email_verified, language, username, avatar_key, created_at, updated_at, kind, theme_style)
     VALUES ('${email}', '${hashPassword(password)}', '${role}', 1, 'approved', 1, 'zh', '${username}', '', '${ts}', '${ts}', 'human', 'nova')`
  )
  return wrangler(`SELECT id, email, role, theme_style FROM users WHERE email = '${email}'`)[0]
}
const userA = mkUser(EMAIL_A, "qa-nat-a", passwordA, "admin")
const userB = mkUser(EMAIL_B, "qa-nat-b", passwordB, "user")
console.error("userA:", JSON.stringify(userA), "userB:", JSON.stringify(userB))
state.users = { A: userA, B: userB }
state.passwords = { A: passwordA, B: passwordB }

// ── 2. 铸会话（token_hash = sha256(token)） ─────────────────────
const mkSession = (uid) => {
  const token = randomBytes(32).toString("base64url")
  const sid = randomBytes(8).toString("hex") + "-qa"
  const t = Math.floor(Date.now() / 1000)
  wrangler(
    `INSERT INTO sessions (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ('${sid}', '${sha256hex(token)}', ${uid}, 0, ${t}, ${t}, ${t + 7 * 24 * 3600}, 'qa', 'ciki-theme-qa')`
  )
  return token
}
const cookieA = mkSession(userA.id)
const cookieB = mkSession(userB.id)
state.cookies = { A: cookieA, B: cookieB }

// ── 3. API 侧铸数（A 的会话） ───────────────────────────────────
const A = new Api("A")
A.cookies.set("ciki_session", cookieA)
const B = new Api("B")
B.cookies.set("ciki_session", cookieB)

// 自证会话有效 + role
const meA = await A.json("GET", "/api/me")
if (meA.status !== 200 || meA.data?.id !== userA.id) {
  console.error("A session invalid:", meA.status, JSON.stringify(meA.data))
  process.exit(2)
}
console.error("me(A):", JSON.stringify({ id: meA.data.id, role: meA.data.role, themeStyle: meA.data.themeStyle }))
state.meA = { role: meA.data.role, themeStyle: meA.data.themeStyle }

// 3.1 空间
const spaceRes = await A.json("POST", "/api/spaces", {
  name: `${QA_MARK}`,
  description: "主题全矩阵验收专用空间（测后拆除）"
})
if (spaceRes.status !== 201) {
  console.error("space create failed:", spaceRes.status, JSON.stringify(spaceRes.data))
  process.exit(2)
}
const spaceId = spaceRes.data.id
console.error("space:", spaceId)
state.spaceId = spaceId

// 3.2 B 加入空间（editor）才能评论
const memberRes = await A.json("POST", `/api/spaces/${spaceId}/members`, {
  userId: userB.id,
  role: "editor"
})
if (memberRes.status !== 200 && memberRes.status !== 201) {
  console.error("member add failed:", memberRes.status, JSON.stringify(memberRes.data))
  process.exit(2)
}

// 3.3 上传：场景 JSON / 预览 PNG / Embed HTML
const sceneUp = await A.upload("/api/files", "qa-scene.json", sceneJson, "application/json")
if (sceneUp.status !== 201) { console.error("scene upload failed:", sceneUp.status, JSON.stringify(sceneUp.data)); process.exit(2) }
const pngUp = await A.upload("/api/files", "qa-preview.png", makePng(), "image/png")
if (pngUp.status !== 201) { console.error("png upload failed:", pngUp.status, JSON.stringify(pngUp.data)); process.exit(2) }
const embedUp = await A.upload("/api/files/embeds", "qa-theme-probe.html", embedHtml, "text/html")
if (embedUp.status !== 201) { console.error("embed upload failed:", embedUp.status, JSON.stringify(embedUp.data)); process.exit(2) }
console.error("scene:", sceneUp.data.key, "png:", pngUp.data.key, "embed:", embedUp.data.key)
state.uploads = [
  { kind: "scene", key: sceneUp.data.key },
  { kind: "preview", key: pngUp.data.key },
  { kind: "embed", key: embedUp.data.key }
]

// 3.4 汇流页
const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "文本与代码" }] },
    { type: "paragraph", content: [{ type: "text", text: "正文段落：用于量测 --foreground 与 --background 的对比度。The quick brown fox jumps over the lazy dog 0123456789。" }] },
    {
      type: "codeBlock", attrs: { language: "typescript" },
      content: [{ type: "text", text: "export function contrast(fg: RGB, bg: RGB): number {\n  const l1 = luminance(fg)\n  const l2 = luminance(bg)\n  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)\n}" }]
    },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "表格" }] },
    {
      type: "table",
      content: [
        { type: "tableRow", content: [
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "令牌" }] }] },
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "浅色" }] }] },
          { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "暗色" }] }] }
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "background" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "#faf6f1" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "#191612" }] }] }
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "primary" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "#5f7050" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "#a3b18a" }] }] }
        ] }
      ]
    },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "画布" }] },
    {
      type: "excalidraw",
      attrs: { sceneKey: sceneUp.data.key, previewKey: pngUp.data.key, extractedText: "QA 画布：矩形与圆形", width: 640 }
    },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "嵌入" }] },
    {
      type: "htmlEmbed",
      attrs: { key: embedUp.data.key, height: 360, name: "qa-theme-probe.html" }
    },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "引用块：主题令牌逐项核对。" }] }] },
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "已完成：对比度计算脚本" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "待办：真值表逐格核对" }] }] }
      ]
    }
  ]
}
const contentHtml = `<h2>文本与代码</h2><p>正文段落：用于量测 --foreground 与 --background 的对比度。The quick brown fox jumps over the lazy dog 0123456789。</p><pre><code class="language-typescript">export function contrast(fg: RGB, bg: RGB): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}</code></pre><h2>表格</h2><div class="tableWrapper"><table><thead><tr><th><p>令牌</p></th><th><p>浅色</p></th><th><p>暗色</p></th></tr></thead><tbody><tr><td><p>background</p></td><td><p>#faf6f1</p></td><td><p>#191612</p></td></tr><tr><td><p>primary</p></td><td><p>#5f7050</p></td><td><p>#a3b18a</p></td></tr></tbody></table></div><h2>画布</h2><img data-type="excalidraw" data-scene-key="${sceneUp.data.key}" data-preview-key="${pngUp.data.key}" alt="QA 画布：矩形与圆形" src="/api/files/${pngUp.data.key}" width="640"><h2>嵌入</h2><div data-type="html-embed" data-key="${embedUp.data.key}" data-height="360" data-name="qa-theme-probe.html"></div><blockquote><p>引用块：主题令牌逐项核对。</p></blockquote><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked disabled></label><div><p>已完成：对比度计算脚本</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox" disabled></label><div><p>待办：真值表逐格核对</p></div></li></ul>`
const contentText = "文本与代码\n正文段落：用于量测 --foreground 与 --background 的对比度。\n表格\n令牌 浅色 暗色\n画布\n嵌入\n引用块：主题令牌逐项核对。"

const pageRes = await A.json("POST", "/api/pages", {
  title: `${QA_MARK} 汇流页`,
  spaceId,
  contentJson: JSON.stringify(doc),
  contentHtml,
  contentText
})
if (pageRes.status !== 201) {
  console.error("page create failed:", pageRes.status, JSON.stringify(pageRes.data))
  process.exit(2)
}
const pageId = pageRes.data.id
console.error("page:", pageId, JSON.stringify({ title: pageRes.data.title }))
state.pageId = pageId

// 3.5 B 评论 ×2 → A 的通知
for (const body of [
  "QA 评论一：**粗体**、`行内代码`、_斜体_ 与 [链接](https://example.com)。",
  "QA 评论二：代码块主题。\n\n```ts\nconst theme: string = \"natural\" // eink?\n```\n\n> 引用一行看看次级文字。"
]) {
  const c = await B.json("POST", `/api/pages/${pageId}/comments`, { bodyMd: body, parentId: null })
  if (c.status !== 201) { console.error("comment failed:", c.status, JSON.stringify(c.data)); process.exit(2) }
  console.error("comment:", c.data.id)
}
const notif = await A.json("GET", "/api/notifications")
console.error("notifications(A):", notif.status, JSON.stringify(notif.data).slice(0, 300))

// ── 4. 铸后计数 ─────────────────────────────────────────────────
const after = wrangler(
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM spaces) AS spaces, (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS pages_active, (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM notifications) AS notifications, (SELECT COUNT(*) FROM sessions) AS sessions"
)[0]
state.afterMint = after
console.error("after mint:", JSON.stringify(after))

writeFileSync(new URL("./state.json", import.meta.url), JSON.stringify(state, null, 1))
console.error("state.json written")
console.log("MINT OK")
