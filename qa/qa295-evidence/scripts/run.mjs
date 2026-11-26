/**
 * QA #295 生产真跑：用户管理页「用户名」列验收
 *
 * 被测：https://ciki.oneboy.app （生产部署，版本 v1.0.0-308-7fcfde1 = PR #295 合并提交）
 * 路径：真实登录表单 → /admin/users 表格真实渲染 → 与生产 D1 库内值逐行比对
 *
 * 用法：
 *   export QA_EMAIL=... QA_PASSWORD=... QA_UID=...
 *   export QA_OUT=/tmp/qa295/out QA_D1Q=/tmp/qa295/d1q.sh
 *   node run.mjs
 *
 * 凭据只从环境变量读；cookies / storage state 不落盘、不入库。
 * 输出：$QA_OUT/results.json、$QA_OUT/shots/*.png
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { chromium } from "playwright-core"

const BASE = "https://ciki.oneboy.app"
const OUT = process.env.QA_OUT || "/tmp/qa295/out"
const SHOTS = path.join(OUT, "shots")
fs.mkdirSync(SHOTS, { recursive: true })

// 凭据一律从环境变量读（不落盘、不入库）：QA_EMAIL / QA_PASSWORD / QA_UID
const env = {
  QA_EMAIL: process.env.QA_EMAIL,
  QA_PASSWORD: process.env.QA_PASSWORD,
  QA_UID: process.env.QA_UID
}
if (!env.QA_EMAIL || !env.QA_PASSWORD) {
  throw new Error("需先导出 QA_EMAIL / QA_PASSWORD / QA_UID")
}

const D1Q = process.env.QA_D1Q || "/tmp/qa295/d1q.sh"
function dbUsers() {
  const out = execFileSync(
    D1Q,
    [
      "SELECT id, email, username, kind, role, is_active, approval_status, owner_user_id, email_verified, language, created_at FROM users ORDER BY id",
      "[]",
    ],
    { encoding: "utf8" }
  )
  const parsed = JSON.parse(out)
  if (!parsed.success) throw new Error("D1 read failed")
  return parsed.result[0].results
}

const results = []
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: Boolean(pass), detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${desc}${pass ? "" : " :: " + JSON.stringify(detail)}`)
}

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.HOME +
    "/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
})
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN"
})
const page = await ctx.newPage()

// 采集管理员接口原始 JSON（同一会话内 fetch，与页面同源带 cookie）
const apiJson = {}
page.on("response", async (resp) => {
  const url = resp.url()
  if (url.includes("/api/admin/users")) {
    try {
      apiJson[url] = { status: resp.status(), body: await resp.json() }
    } catch {
      /* ignore */
    }
  }
})

try {
  // ── 1. 登录（真实表单） ─────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" })
  await page.fill("#login-email", env.QA_EMAIL)
  await page.fill("#login-password", env.QA_PASSWORD)
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]')
  ])
  check("L1", "生产登录表单可用（QA 管理员会话建立）", true, { url: page.url() })

  // ── 2. 打开用户管理页 ──────────────────────────────────────────────
  await page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("table thead th", { timeout: 30000 })
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr td").length > 3,
    null,
    { timeout: 30000 }
  )
  await page.screenshot({ path: path.join(SHOTS, "01-admin-users-zh.png"), fullPage: true })

  const readTable = async () =>
    page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll("table thead th")).map(
        (th) => (th.innerText || "").trim()
      )
      const rows = Array.from(document.querySelectorAll("table tbody tr")).map((tr) => ({
        cells: Array.from(tr.querySelectorAll("td")).map((td) =>
          (td.innerText || "").trim()
        ),
        actionButtons: tr.querySelectorAll("td:last-child button").length,
        firstCellBadges: Array.from(
          tr.querySelectorAll("td:first-child span, td:first-child [class*='inline-flex']")
        )
          .map((el) => (el.innerText || "").trim())
          .filter(Boolean)
      }))
      return { headers, rows, htmlLang: document.documentElement.lang }
    })

  const zh = await readTable()

  // ── 3. 表头（中文） ────────────────────────────────────────────────
  const expectedZh = ["邮箱", "用户名", "角色", "状态", "注册于", "操作"]
  check(
    "H1",
    "中文表头序列 = 邮箱/用户名/角色/状态/注册于/操作（「用户名」紧跟「邮箱」）",
    JSON.stringify(zh.headers) === JSON.stringify(expectedZh),
    { got: zh.headers, expected: expectedZh }
  )
  check(
    "H2",
    "「用户名」列位于「邮箱」列之后（列序第 2 位）",
    zh.headers[0] === "邮箱" && zh.headers[1] === "用户名",
    { headers: zh.headers }
  )
  check("H3", "表头列数 = 6", zh.headers.length === 6, { n: zh.headers.length })

  // ── 4. 与生产 D1 库内逐行比对 ──────────────────────────────────────
  const db = dbUsers()
  const dbById = new Map(db.map((u) => [u.id, u]))
  const apiResp = await page.evaluate(async () => {
    const r = await fetch("/api/admin/users", { credentials: "include" })
    return { status: r.status, body: await r.json() }
  })
  const apiBody = apiResp.body
  const apiById = new Map((apiBody ?? []).map((u) => [u.id, u]))

  const rowChecks = []
  for (const row of zh.rows) {
    const firstCell = row.cells[0] ?? ""
    const usernameCell = row.cells[1]
    // 第一列展示名对普通用户即邮箱，对 agent 为「邮箱（owner 的 Agent）」形态
    const emailMatch = db.find(
      (u) =>
        firstCell.includes(u.email) ||
        (apiById.get(u.id) && firstCell.includes(apiById.get(u.id).email))
    )
    if (!emailMatch) {
      rowChecks.push({ email: null, firstCell, usernameCell, ok: false })
      continue
    }
    const dbUser = dbById.get(emailMatch.id)
    const apiUser = apiById.get(emailMatch.id)
    const ok =
      usernameCell === (dbUser?.username ?? null) &&
      apiUser?.username === dbUser?.username
    rowChecks.push({
      id: dbUser.id,
      kind: dbUser.kind,
      dbUsername: dbUser.username,
      uiUsername: usernameCell,
      apiUsername: apiUser?.username ?? null,
      firstCell,
      ok
    })
  }
  check(
    "U1",
    "每行「用户名」单元格 = 库内 users.username（普通用户行 + agent 行全部覆盖）",
    rowChecks.length > 0 && rowChecks.every((r) => r.ok),
    rowChecks
  )
  const humanRows = rowChecks.filter((r) => r.kind === "human")
  const agentRows = rowChecks.filter((r) => r.kind === "agent")
  check(
    "U2",
    "普通用户行 username 与库内一致（至少 1 行）",
    humanRows.length >= 1 && humanRows.every((r) => r.ok),
    humanRows
  )
  check(
    "U3",
    "agent 行 username 与库内一致（至少 1 行）",
    agentRows.length >= 1 && agentRows.every((r) => r.ok),
    agentRows
  )
  check(
    "U4",
    "后端 userDto 下发 username 字段，且与库内一致（每个用户都有该字段）",
    apiBody !== null &&
      Array.isArray(apiBody) &&
      apiBody.every((u) => typeof u.username === "string") &&
      apiBody.every((u) => u.username === dbById.get(u.id)?.username),
    { apiCount: apiBody?.length ?? null }
  )

  // ── 5. 其余列不变 ──────────────────────────────────────────────────
  // C2：角色/状态/注册于 三列取值仍与库内一致（并核对行序 = created_at DESC）
  const roleLabel = { admin: "管理员", user: "普通用户" }
  const statusLabel = { active: "正常", pending: "待批准", rejected: "已拒绝", inactive: "已停用" }
  const colChecks = []
  for (const row of zh.rows) {
    const firstCell = row.cells[0] ?? ""
    const emailMatch = db.find((u) => firstCell.includes(u.email))
    if (!emailMatch) {
      colChecks.push({ firstCell, ok: false, why: "email not matched" })
      continue
    }
    const u = dbById.get(emailMatch.id)
    const roleCell = row.cells[2] ?? ""
    const statusCell = row.cells[3] ?? ""
    const dateCell = row.cells[4] ?? ""
    const actionsCell = row.cells[5] ?? ""
    const actionBtns = row.actionButtons ?? 0
    const expectRole = roleLabel[u.role]
    const expectStatus =
      u.is_active === 1 && u.approval_status === "approved"
        ? statusLabel.active
        : statusLabel[u.approval_status] ?? statusLabel.inactive
    // 注册于：库内 UTC 日期 ±1 天（前端按浏览器本地时区格式化）
    const d = new Date(u.created_at)
    const utcDay = Math.floor(d.getTime() / 86400000)
    const uiDay = Date.parse(dateCell + "T00:00:00Z") / 86400000
    const dayOk = Number.isFinite(uiDay) && Math.abs(uiDay - utcDay) <= 1
    colChecks.push({
      id: u.id,
      roleCell,
      expectRole,
      roleOk: roleCell.includes(expectRole),
      statusCell,
      expectStatus,
      statusOk: statusCell.includes(expectStatus),
      dateCell,
      dbCreatedAt: u.created_at,
      dateOk: dayOk,
      actionsOk: actionBtns > 0,
      actionButtons: actionBtns,
      cells: row.cells.length,
      ok:
        roleCell.includes(expectRole) &&
        statusCell.includes(expectStatus) &&
        dayOk &&
        actionBtns > 0 &&
        row.cells.length === 6
    })
  }
  check(
    "C2",
    "角色/状态/注册于/操作 四列取值仍与库内一致（每行 6 格）",
    colChecks.length > 0 && colChecks.every((c) => c.ok),
    colChecks
  )
  const orderDb = [...db]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map((u) => u.id)
  const orderUi = zh.rows
    .map((r) => db.find((u) => (r.cells[0] ?? "").includes(u.email))?.id)
    .filter((x) => x !== undefined)
  check(
    "C3",
    "行序 = 库内 created_at DESC（新增列未改变排序）",
    JSON.stringify(orderUi) === JSON.stringify(orderDb),
    { orderUi, orderDb }
  )
  const otherColsOk = zh.rows.every((r) => {
    const email = db.find((u) => (r.cells[0] ?? "").includes(u.email))
    if (!email) return false
    const api = apiById.get(email.id)
    if (!api) return false
    const roleCell = r.cells[2] ?? ""
    const roleOk =
      api.role === "admin" ? roleCell.includes("管理员") : roleCell.length > 0
    const statusCell = r.cells[3] ?? ""
    const statusOk = api.isActive ? statusCell.includes("正常") || statusCell.length > 0 : true
    const createdCell = r.cells[4] ?? ""
    const createdOk = createdCell.length > 0
    const actionsCell = r.cells[5] ?? ""
    const actionsOk = actionsCell.length > 0 || (await1(r))
    return roleOk && statusOk && createdOk && actionsOk
  })
  function await1(r) {
    // 操作列是图标按钮，innerText 可能为空；改为检查存在 button
    return r.cells.length === 6
  }
  check(
    "C1",
    "其余列（角色/状态/注册于/操作）仍渲染，每行 6 个单元格",
    otherColsOk && zh.rows.every((r) => r.cells.length === 6),
    { rowCellCounts: zh.rows.map((r) => r.cells.length) }
  )

  // ── 6. Agent 徽标 / 「（你）」标记仍在第一列 ─────────────────────────
  const agentRowInfo = zh.rows
    .map((r, i) => {
      const firstCell = r.cells[0] ?? ""
      const ownerForm = firstCell.includes("的 Agent）")
      const badge = firstCell.includes("Agent") && !ownerForm
      return { i, firstCell, ownerForm, badge }
    })
    .filter((r) => r.ownerForm || r.badge)
  check(
    "A1",
    "agent 行的 Agent 标记仍在第一列（有 owner → 「（owner 的 Agent）」形态；无 owner → Agent 徽标形态）",
    agentRowInfo.length >= 2 &&
      agentRowInfo.some((r) => r.ownerForm) &&
      agentRowInfo.some((r) => r.badge),
    agentRowInfo
  )
  const youRows = zh.rows
    .map((r, i) => ({ i, firstCell: r.cells[0] ?? "" }))
    .filter((r) => r.firstCell.includes("（你）"))
  check(
    "A2",
    "「（你）」标记仍在第一列，且只出现在本人行",
    youRows.length === 1 && youRows[0].firstCell.includes(env.QA_EMAIL),
    youRows
  )

  // ── 7. loading / 空态 colSpan = 6 ──────────────────────────────────
  await page.route("**/api/admin/users**", async (route) => {
    await new Promise((r) => setTimeout(r, 6000))
    await route.continue()
  })
  await page.reload({ waitUntil: "load" })
  await page.waitForFunction(
    () => (document.querySelector("table tbody td")?.innerText || "").includes("加载中"),
    null,
    { timeout: 25000 }
  )
  const loadingSpan = await page.evaluate(
    () => document.querySelector("table tbody td")?.getAttribute("colspan")
  )
  await page.unroute("**/api/admin/users**")
  check("L2", "加载态单元格 colSpan = 6", loadingSpan === "6", { loadingSpan })

  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr td").length > 3,
    null,
    { timeout: 30000 }
  )
  // 空态：切到「待批准」筛选（生产无待批准账号）
  await page.getByRole("radio", { name: "待批准", exact: true }).click().catch(async () => {
    await page.getByText("待批准", { exact: true }).first().click()
  })
  await page.waitForFunction(
    () => {
      const td = document.querySelector("table tbody td")
      return td && (td.innerText || "").includes("没有待批准")
    },
    null,
    { timeout: 20000 }
  )
  const emptyState = await page.evaluate(() => {
    const td = document.querySelector("table tbody td")
    return { colspan: td?.getAttribute("colspan"), text: (td?.innerText || "").trim() }
  })
  await page.screenshot({ path: path.join(SHOTS, "02-admin-users-empty-pending.png"), fullPage: true })
  check(
    "L3",
    "空态单元格 colSpan = 6 且文案为待批准空态",
    emptyState.colspan === "6" && emptyState.text.includes("没有待批准"),
    emptyState
  )

  // 回到「全部用户」
  await page.getByRole("radio", { name: "全部用户", exact: true }).click().catch(async () => {
    await page.getByText("全部用户", { exact: true }).first().click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr td").length > 3,
    null,
    { timeout: 30000 }
  )

  // ── 8. 英文表头（真实 UI 切语言） ───────────────────────────────────
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("text=界面语言", { timeout: 30000 }).catch(() => {})
  await page.getByRole("radio", { name: "English", exact: true }).click().catch(async () => {
    await page.getByText("English", { exact: true }).first().click()
  })
  // 点「语言」卡片内的保存按钮（锚定在 English 分段控件所在卡片里）
  await page.evaluate(() => {
    const radio = Array.from(document.querySelectorAll('[role="radio"]')).find(
      (el) => (el.innerText || "").trim() === "English"
    )
    if (!radio) throw new Error("English radio not found")
    let card = radio
    while (card && !String(card.className).includes("group/card")) card = card.parentElement
    if (!card) throw new Error("language card not found")
    const btn = Array.from(card.querySelectorAll("button")).find(
      (b) => (b.innerText || "").trim() === "保存"
    )
    if (!btn) throw new Error("language save button not found")
    btn.click()
  })
  await page.waitForTimeout(1500)
  await page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("table thead th", { timeout: 30000 })
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr td").length > 3,
    null,
    { timeout: 30000 }
  )
  await page.screenshot({ path: path.join(SHOTS, "03-admin-users-en.png"), fullPage: true })
  const en = await readTable()
  const expectedEn = ["Email", "Username", "Role", "Status", "Registered", "Actions"]
  check(
    "E1",
    "英文表头序列 = Email/Username/Role/Status/Registered/Actions",
    JSON.stringify(en.headers) === JSON.stringify(expectedEn),
    { got: en.headers, expected: expectedEn }
  )
  check(
    "E2",
    "英文下「（你）」标记变为 (you) 且仍在第一列",
    en.rows.filter((r) => (r.cells[0] ?? "").includes("(you)")).length === 1,
    en.rows.map((r) => r.cells[0])
  )
  const enUsernames = en.rows.map((r) => r.cells[1])
  const zhUsernames = zh.rows.map((r) => r.cells[1])
  check(
    "E3",
    "中英切换后「用户名」列取值不变（同一批用户、同一批库内值）",
    JSON.stringify(enUsernames) === JSON.stringify(zhUsernames),
    { enUsernames, zhUsernames }
  )
  check("E4", "页面 html lang = en", en.htmlLang === "en", { htmlLang: en.htmlLang })
  const dbLang = dbUsers().find((u) => u.id === Number(env.QA_UID))?.language
  check("E5", "语言切换已写回账号（库内 users.language = en）", dbLang === "en", { dbLang })

  // ── 9. API 原始响应留证 ────────────────────────────────────────────
  fs.writeFileSync(
    path.join(OUT, "api-admin-users.json"),
    JSON.stringify(apiBody, null, 2)
  )
} catch (err) {
  check("FATAL", "脚本执行异常", false, { error: String(err && err.stack ? err.stack : err) })
  await page.screenshot({ path: path.join(SHOTS, "99-fatal.png"), fullPage: true }).catch(() => {})
} finally {
  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, results }, null, 2)
  )
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\nTOTAL=${results.length} PASS=${results.length - failed.length} FAIL=${failed.length}`)
console.log(failed.map((f) => `FAILED: ${f.id} ${f.desc}`).join("\n"))
process.exit(failed.length ? 1 : 0)
