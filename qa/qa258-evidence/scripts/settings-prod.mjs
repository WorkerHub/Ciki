// QA258 生产验收：标准 1（设置页 6 风格 / 明暗切换 / 刷新保持 / 账号往返）与标准 2（distill 回落 + 400）
import { chromium } from "playwright-core"
import fs from "node:fs"

const EXEC = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
const BASE = process.env.QA_BASE || "https://ciki.oneboy.app"
const PROXY = process.env.QA_PROXY || ""
const HOST = new URL(BASE).hostname
const STATE = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/state.json", "utf8"))
const ADMIN = STATE.users.admin.token
const DISTILL = STATE.users.distill.token
const PAGE = STATE.pages[0].id
const OUT = process.env.QA_OUT || "/tmp/ciki-qa258-prod/settings-result.json"

const STYLES = ["nova", "paper", "natural", "eink", "notion", "sketch"]
const STYLE_LABELS = { nova: "Nova", paper: "纸面", natural: "自然", eink: "墨纸", notion: "Notion", sketch: "手绘" }
const results = []
const ok = (id, pass, detail, evidence) => { results.push({ id, pass, detail, evidence }); console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${detail}`) }

// ---------------- A. API 契约 ----------------
async function api(path, { method = "GET", cookie, body } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = `ciki_session=${cookie}`
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

const apiEvidence = { valid: {}, invalid: [], alias: null, distillAccount: null }
for (const s of STYLES) {
  const put = await api("/api/me/theme", { method: "PUT", cookie: ADMIN, body: { themeStyle: s } })
  const me = await api("/api/me", { cookie: ADMIN })
  apiEvidence.valid[s] = { putStatus: put.status, readBack: me.json.themeStyle }
}
ok("A1", STYLES.every(s => apiEvidence.valid[s].putStatus === 200 && apiEvidence.valid[s].readBack === s),
  "6 个合法风格 PUT /api/me/theme 均 200 且 GET /api/me 回读一致", apiEvidence.valid)

const INVALID = ["distill", "notion2", "", null, 123, "NOTION", "nova ", ["nova"], { a: 1 }]
for (const v of INVALID) {
  const r = await api("/api/me/theme", { method: "PUT", cookie: ADMIN, body: { themeStyle: v } })
  apiEvidence.invalid.push({ input: JSON.stringify(v), status: r.status, code: r.json.code ?? null, error: r.json.error ?? null })
}
const allInvalid400 = apiEvidence.invalid.every(x => x.status === 400)
ok("A2", allInvalid400, "非法值（含 distill）全部 400", apiEvidence.invalid)

const alias = await api("/api/me/theme-style", { method: "PUT", cookie: ADMIN, body: { style: "distill" } })
apiEvidence.alias = { status: alias.status, code: alias.json.code ?? null, error: alias.json.error ?? null }
ok("A3", alias.status === 400, "别名端点 /api/me/theme-style 传 distill → 400", apiEvidence.alias)

const distillMe = await api("/api/me", { cookie: DISTILL })
apiEvidence.distillAccount = { status: distillMe.status, themeStyle: distillMe.json.themeStyle }
ok("A4", distillMe.status === 200 && distillMe.json.themeStyle === "nova",
  "预置 theme_style='distill' 账号读取回落 nova", apiEvidence.distillAccount)

// ---------------- B/C. 浏览器 ----------------
const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const consoleErrors = []
async function makeCtx(token, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block", ...(PROXY ? { proxy: { server: PROXY, bypass: "127.0.0.1,localhost" } } : {}) })
  await ctx.addCookies([{ name: "ciki_session", value: token, domain: HOST, path: "/" }])
  const page = await ctx.newPage()
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ where: page.url(), text: m.text().slice(0, 200) }) })
  page.on("pageerror", (e) => consoleErrors.push({ where: page.url(), text: "pageerror: " + String(e).slice(0, 200) }))
  return { ctx, page }
}
async function goto(page, url, ready) {
  await page.goto(`${BASE}${url}`, { waitUntil: "load", timeout: 90000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="button"]').length > 0, null, { timeout: 25000 }).catch(() => {})
  if (ready) await page.waitForSelector(ready, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(500)
}
async function groupInfo(page) {
  return page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[role="radiogroup"]')).map((g) => ({
      ariaLabel: g.getAttribute("aria-label"),
      items: Array.from(g.querySelectorAll('[role="radio"]')).map((r) => ({
        text: (r.textContent || "").trim(),
        value: r.getAttribute("data-value") || r.getAttribute("value"),
        state: r.getAttribute("data-state"),
        checked: r.getAttribute("aria-checked")
      }))
    }))
    return groups
  })
}

// B. 管理员设置页
const { ctx: actx, page: apage } = await makeCtx(ADMIN)
await goto(apage, "/settings", '[role="radiogroup"]')
const groups = await groupInfo(apage)
const styleGroup = groups.find((g) => (g.ariaLabel || "").includes("风格"))
const styleTexts = styleGroup ? styleGroup.items.map((i) => i.text) : []
const expectTexts = STYLES.map((s) => STYLE_LABELS[s])
const noDistill = !styleTexts.some((t) => /学术|distill/i.test(t))
ok("B1", !!styleGroup && styleGroup.items.length === 6 && expectTexts.every((t) => styleTexts.includes(t)) && noDistill,
  `设置页风格 radiogroup 恰 6 项且无 distill（实测 ${styleGroup ? styleGroup.items.length : "N/A"} 项：${styleTexts.join("/")}）`,
  { groups, styleGroup })

const roundTrips = []
for (const s of STYLES) {
  const label = STYLE_LABELS[s]
  const clicked = await apage.evaluate((label) => {
    const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((x) => (x.getAttribute("aria-label") || "").includes("风格"))
    if (!g) return "no-group"
    const item = Array.from(g.querySelectorAll('[role="radio"]')).find((r) => (r.textContent || "").trim() === label)
    if (!item) return "no-item"
    item.click()
    return "clicked"
  }, label)
  await apage.waitForTimeout(350)
  const saveState = await apage.evaluate(() => {
    const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((x) => (x.getAttribute("aria-label") || "").includes("风格"))
    const card = g ? g.closest('[data-slot="card"]') : null
    const btn = card ? Array.from(card.querySelectorAll('[data-slot="button"]')).find((b) => (b.textContent || "").trim() === "保存") : null
    if (!btn) return { found: false }
    const disabled = btn.hasAttribute("disabled")
    btn.click()
    return { found: true, disabledBeforeClick: disabled }
  })
  await apage.waitForTimeout(1200)
  const me = await api("/api/me", { cookie: ADMIN })
  await goto(apage, "/settings", '[role="radiogroup"]')
  const applied = await apage.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute("data-theme"),
    dataMode: document.documentElement.getAttribute("data-mode"),
    checked: Array.from(document.querySelectorAll('[role="radiogroup"]')).find((x) => (x.getAttribute("aria-label") || "").includes("风格"))
      ?.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim() || null
  }))
  roundTrips.push({ style: s, clicked, saveState, account: me.json.themeStyle, afterReload: applied })
  console.log(`   往返 ${s}: account=${me.json.themeStyle} reload data-theme=${applied.dataTheme} checked=${applied.checked}`)
}
const allRoundTrip = roundTrips.every(r => r.account === r.style && r.afterReload.dataTheme === r.style)
ok("B2", allRoundTrip, "6 套风格「选择→保存→账号写回→刷新后保持」全部成立", roundTrips)

// B3. 明暗模式循环 + 刷新保持
const cycle = []
for (let i = 0; i < 4; i++) {
  const st = await apage.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.getAttribute("aria-label") || "").startsWith("主题："))
    if (!b) return null
    b.click()
    return b.getAttribute("aria-label")
  })
  await apage.waitForTimeout(500)
  const after = await apage.evaluate(() => ({
    dataMode: document.documentElement.getAttribute("data-mode"),
    storedMode: (() => { try { const raw = localStorage.getItem("ciki-theme"); return raw ? JSON.parse(raw).state.mode : null } catch { return null } })()
  }))
  cycle.push({ clicked: st, ...after })
}
await goto(apage, "/settings", '[role="radiogram"]'.replace("gram", "group"))
const afterReload = await apage.evaluate(() => ({
  dataMode: document.documentElement.getAttribute("data-mode"),
  storedMode: (() => { try { const raw = localStorage.getItem("ciki-theme"); return raw ? JSON.parse(raw).state.mode : null } catch { return null } })()
}))
// 顶栏按钮是 auto→light→dark→auto 循环：设置值看 state.mode，data-mode 是按系统偏好解析后的实际生效模式
const modeSeq = cycle.map(c => c.storedMode)
ok("B3", JSON.stringify(modeSeq) === JSON.stringify(["light", "dark", "auto", "light"]) && afterReload.storedMode === cycle[cycle.length - 1].storedMode,
  `模式循环 auto→light→dark→auto（设置值实测 ${modeSeq.join("→")}，auto 解析为 ${cycle[2].dataMode}），刷新后保持 ${afterReload.storedMode}`,
  { cycle, afterReload, note: "data-mode=auto 时按系统偏好解析；headless Chromium 系统偏好为 light" })

// C. distill 账号
const { ctx: dctx, page: dpage } = await makeCtx(DISTILL)
await goto(dpage, `/p/${PAGE}`, ".wiki-content")
const distillPage = await dpage.evaluate(() => ({
  dataTheme: document.documentElement.getAttribute("data-theme"),
  dataMode: document.documentElement.getAttribute("data-mode"),
  hasWiki: !!document.querySelector(".wiki-content"),
  bodyText: (document.body.innerText || "").slice(0, 60)
}))
ok("C1", distillPage.dataTheme === "nova" && distillPage.hasWiki,
  `distill 账号打开阅读页回落 nova（data-theme=${distillPage.dataTheme}，页面正常渲染=${distillPage.hasWiki}）`, distillPage)

await goto(dpage, "/settings", '[role="radiogroup"]')
const dGroups = await groupInfo(dpage)
const dStyleGroup = dGroups.find((g) => (g.ariaLabel || "").includes("风格"))
const dTexts = dStyleGroup ? dStyleGroup.items.map((i) => i.text) : []
const dNoDistill = !dTexts.some((t) => /学术|distill/i.test(t))
ok("C2", !!dStyleGroup && dStyleGroup.items.length === 6 && dNoDistill,
  `distill 账号设置页同样是 6 套风格且无 distill（${dTexts.join("/")}）`, { dGroups })

// 受控组件：先点风格，等 React 重渲染（保存按钮解禁），再点保存
const dClicked = await dpage.evaluate(() => {
  const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((x) => (x.getAttribute("aria-label") || "").includes("风格"))
  const item = g ? Array.from(g.querySelectorAll('[role="radio"]')).find((r) => (r.textContent || "").trim() === "手绘") : null
  if (!item) return { clicked: false }
  item.click()
  return { clicked: true }
})
await dpage.waitForTimeout(500)
const dSave = await dpage.evaluate(() => {
  const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((x) => (x.getAttribute("aria-label") || "").includes("风格"))
  const card = g ? g.closest('[data-slot="card"]') : null
  const btn = card ? Array.from(card.querySelectorAll('[data-slot="button"]')).find((b) => (b.textContent || "").trim() === "保存") : null
  if (!btn) return { saved: false, reason: "no-save-button" }
  const disabled = btn.hasAttribute("disabled")
  if (!disabled) btn.click()
  return { saved: !disabled, disabledBeforeClick: disabled }
})
await dpage.waitForTimeout(1500)
const dMe = await api("/api/me", { cookie: DISTILL })
await goto(dpage, `/p/${PAGE}`, ".wiki-content")
const dAfter = await dpage.evaluate(() => document.documentElement.getAttribute("data-theme"))
ok("C3", dSave.saved && dMe.json.themeStyle === "sketch" && dAfter === "sketch",
  `distill 账号可切换并保存其他风格（保存手绘→账号 ${dMe.json.themeStyle}，刷新后 data-theme=${dAfter}）`, { dClicked, dSave, account: dMe.json.themeStyle, afterReload: dAfter })

const relevantErrors = consoleErrors.filter((e) => !/cf-ray|challenge-platform|Failed to read the 'localStorage'/i.test(e.text))
ok("C4", relevantErrors.length === 0, `distill 账号全程无前端报错（过滤 CF 注入/沙箱噪声后 ${relevantErrors.length} 条）`, consoleErrors)

await actx.close(); await dctx.close()
await browser.close()

const out = { at: new Date().toISOString(), base: BASE, results, apiEvidence, consoleErrors }
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
const failed = results.filter((r) => !r.pass)
console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length} -> ${OUT}`)
