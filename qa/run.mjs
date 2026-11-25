// #223 非法 theme 崩溃修复·线上同 commit 栈真跑回归
// 用法: node run.cjs <results-file>
// 环境要求: 本地栈 http://127.0.0.1:9531 (= 生产 commit 65c69e0 同源构建)
// 口令/令牌只从 /tmp/qa-223.pw、/tmp/qa-223/wt.txt 运行时读取，绝不打印、绝不落证据。
import fs from "node:fs"
import { chromium, webkit } from "playwright"

const BASE = "http://127.0.0.1:9531"
const PAGE_ID = "1"
const READ_URL = `${BASE}/p/${PAGE_ID}`
const EDIT_URL = `${BASE}/p/${PAGE_ID}/edit`
const LOGIN_URL = `${BASE}/login`
const RESULTS = process.argv[2] || "/tmp/qa-223/results.json"
const SHOTS = "/tmp/qa-223/shots"
fs.mkdirSync(SHOTS, { recursive: true })

const PW = fs.readFileSync("/tmp/qa-223.pw", "utf8").trim()
const EMAIL = "qa223@example.com"

// —— 断言器 ——
const checks = []
function check(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: detail ?? null })
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${pass ? "" : "  :: " + JSON.stringify(detail)}`)
}

// localStorage 预置值（zustand persist 形态）
const LS = {
  swap: { theme: "paper", style: "light" },        // 验收项1：字段互换（原 12/12 复现值）
  badStyle: { theme: "light", style: "paperx" },   // 验收项2：非法 style
  legalNovaLight: { theme: "light", style: "nova" },
  legalPaperDark: { theme: "dark", style: "paper" },
  garbage: { theme: 123, style: null },            // 附加：完全非法
}

const CRASH_MARKERS = ["Unexpected Application Error"]

// 错误页结构特征：react-router 的 DefaultErrorUI 是 h2 精确文案；扫描错误页元素而非正文文本，
// 避免把样例正文里的描述词当成崩溃（第 1 轮误报教训）。
async function crashStructured(page) {
  return page.evaluate(() => {
    const h2s = [...document.querySelectorAll("h2")].map((h) => (h.textContent || "").trim())
    return {
      errUi: h2s.includes("Unexpected Application Error!"),
      anyH2: h2s.slice(0, 5),
    }
  })
}

async function newContext(browser, kind, { lsValue, viewport, reuseState = false } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    ...(reuseState ? { storageState: "/tmp/qa-223/state.json" } : {}),
  })
  await ctx.addInitScript(
    (v) => {
      if (v) localStorage.setItem("ciki-theme", JSON.stringify({ state: v, version: 0 }))
    },
    lsValue ?? null
  )
  // 屏蔽 PWA Service Worker：与 #211 同因（SW fetch 直通会绕过网络断言）
  await ctx.addInitScript(() => {
    try { navigator.serviceWorker.register = () => Promise.reject(new Error("sw-blocked-qa")) } catch {}
  })
  if (kind === "wk") {
    // webkit 无 serviceWorkers 选项问题，同样用注册替换法
  }
  return ctx
}

function tapNetwork(page) {
  const log = []
  page.on("request", (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith("/api/")) log.push({ m: r.method(), p: u.pathname })
  })
  page.on("response", (r) => {
    try {
      const u = new URL(r.url())
      if (u.pathname.startsWith("/api/")) log.push({ m: r.request().method(), p: u.pathname, s: r.status() })
    } catch {}
  })
  return log
}

function tapConsole(page) {
  const errors = []
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 300))
  })
  page.on("pageerror", (err) => errors.push("PAGEERROR: " + String(err).slice(0, 300)))
  return errors
}

async function login(page, timeout = 20000) {
  // 首跳水合前点击 submit 可能无效（首轮运行偶发）：失败重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("#login-email", { timeout: 20000 })
    await page.fill("#login-email", EMAIL)
    await page.fill("#login-password", PW)
    await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10000 })
    await page.click('button[type="submit"]')
    try {
      await page.waitForURL((u) => !String(u).includes("/login"), { timeout })
      break
    } catch (e) {
      if (attempt === 2) throw e
    }
  }
  await page.waitForSelector("#login-email", { state: "detached", timeout }).catch(() => {})
  await page.waitForTimeout(800)
}

// 页面健康断言：无崩溃标记 + 关键内容在 + 采集 DOM/存储态
async function probe(page, { expectMode = null, expectStyle = null, shot = null } = {}) {
  const struct = await crashStructured(page)
  const attrs = await page.evaluate(() => {
    const r = document.documentElement
    return {
      dataTheme: r.getAttribute("data-theme"),
      dataMode: r.getAttribute("data-mode"),
      dark: r.classList.contains("dark"),
      ls: (() => { try { return JSON.parse(localStorage.getItem("ciki-theme") || "null") } catch { return "RAW:" + localStorage.getItem("ciki-theme") } })(),
      cycleBtn: (() => {
        // locale 无关：未登录页 UI 可能是英文（navigator 语言），提示是 Theme: 而非 主题：
        const btns = [...document.querySelectorAll("button[title], button[aria-label]")]
        const b = btns.find((el) => /(主题|Theme)\s*[：:]/.test((el.getAttribute("title") || "") + (el.getAttribute("aria-label") || "")))
        return b ? { title: b.getAttribute("title"), hasSvg: !!b.querySelector("svg") } : null
      })(),
      bodyText: document.body.innerText.slice(0, 200),
      readOk: !!document.querySelector("[data-readview-container] .wiki-content p, .ProseMirror p"),
    }
  })
  if (shot) await page.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: false })
  return { crashed: struct.errUi, struct, attrs }
}

async function runScenario(browser, kind, scen) {
  const { id, label, lsValue, visit, expectMode, expectStyle, shot } = scen
  // 复用已登录会话：不再逐场景登录
  const ctx = await newContext(browser, kind, { lsValue, reuseState: true })
  const page = await ctx.newPage()
  const net = tapNetwork(page)
  const errs = tapConsole(page)
  try {
    const url = visit === "read" ? READ_URL : visit === "edit" ? EDIT_URL : null
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
      await page.waitForTimeout(1500)
    }
    const { crashed, attrs } = await probe(page)
    const hardErrs = errs.filter(
      (e) => e.includes("PAGEERROR") || e.includes("Minified React error") || e.includes("#130")
    )
    // 预期无害 console error：登录前 /api/me 探活 401（每上下文至多 2 条，#211 先例）。
    // 其余任何 console error 都要全额记录进 detail 待查，不让「过严」变成「放水」。
    const benign401 = errs.filter((e) => e.includes("401"))
    const otherErrs = errs.filter((e) => !e.includes("401"))
    const okNoCrash =
      !crashed && hardErrs.length === 0 && otherErrs.length === 0 && benign401.length <= 2
    check(`${kind}-${id}-a`, `${label}：无崩溃页/无 #130/pageerror/无计划外console错误`, okNoCrash, {
      crashed,
      hardErrs,
      otherErrs,
      benign401Count: benign401.length,
    })

    const lsTheme = attrs.ls && attrs.ls.state ? attrs.ls.state.theme : undefined
    const lsStyle = attrs.ls && attrs.ls.state ? attrs.ls.state.style : undefined
    // DOM 断言
    let domOk = true
    const domDetail = {}
    if (expectStyle) {
      domOk = domOk && attrs.dataTheme === expectStyle
      domDetail.dataTheme = attrs.dataTheme
    }
    if (expectMode) {
      domOk = domOk && attrs.dataMode === expectMode
      domDetail.dataMode = attrs.dataMode
    }
    check(`${kind}-${id}-b`, `${label}：DOM 属性符合回退/保留语义`, domOk, domDetail)

    // 循环按钮健康（挂在页面上即可见）
    check(`${kind}-${id}-c`, `${label}：ThemeCycleButton 渲染且图标存在`, !!attrs.cycleBtn && attrs.cycleBtn.hasSvg, attrs.cycleBtn)

    // 内容健康：正文或编辑器在
    check(`${kind}-${id}-d`, `${label}：页面内容渲染（阅读正文/编辑器）`, attrs.readOk, attrs.bodyText.slice(0, 80))

    await page.screenshot({ path: `${SHOTS}/${shot ?? kind + "-" + id}.png` })
    return { attrs, errs, net }
  } finally {
    await ctx.close()
  }
}

// —— 主流程 ——
// 整轮只登录一次（避免高频登录触发服务端频控，运行#3 曾连续两场景卡在 /login）。
// 场景用 storageState 复用会话 + addInitScript 预置非法 ciki-theme，
// zustand persist rehydrate 兑底逻辑同样被真实触发。
const browser = await chromium.launch({ headless: true })
const results = { chromium: {}, webkit: {}, functional: {} }

// 登录态 storageState（登录页无预置值，保证干净登录）
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await login(page)
  fs.writeFileSync("/tmp/qa-223/state.json", JSON.stringify(await ctx.storageState()))
  await ctx.close()
}
console.log("logged in, storageState saved")

// ============ 验收项1：字段互换 {"theme":"paper","style":"light"} ============
const scenarios = [
  { id: "s1-read", label: "项1 读页·字段互换值（登录态）", lsValue: LS.swap, visit: "read", expectStyle: "nova", expectMode: null, shot: "s1-read" },
  { id: "s1-edit", label: "项1 编辑页·字段互换值（登录态）", lsValue: LS.swap, visit: "edit", expectStyle: "nova", expectMode: null, shot: "s1-edit" },
  { id: "s2-read", label: "项2 读页·非法style(paperx)+theme=light（登录态）", lsValue: LS.badStyle, visit: "read", expectStyle: "nova", expectMode: "light", shot: "s2-read" },
  { id: "s2-edit", label: "项2 编辑页·非法style(paperx)+theme=light（登录态）", lsValue: LS.badStyle, visit: "edit", expectStyle: "nova", expectMode: "light", shot: "s2-edit" },
  { id: "s3-read", label: "附加 读页·完全非法(123/null)（登录态）", lsValue: LS.garbage, visit: "read", expectStyle: "nova", expectMode: null, shot: "s3-read" },
  { id: "s3-edit", label: "附加 编辑页·完全非法(123/null)（登录态）", lsValue: LS.garbage, visit: "edit", expectStyle: "nova", expectMode: null, shot: "s3-edit" },
]
for (const s of scenarios) {
  results.chromium[s.id] = await runScenario(browser, "cr", s)
}

// webkit 抽测项1（两页）
for (const s of [scenarios[0], scenarios[1]]) {
  results.webkit[s.id] = await runScenario(browser, "wk", { ...s, label: s.label + " [webkit]" })
}

await browser.close()

// ============ 项1/项2 补充：登录页（AuthShell 也挂循环按钮）+ 未登录直达 ============
{
  const browser2 = await chromium.launch({ headless: true })
  for (const [key, val] of [["swap", LS.swap], ["badstyle", LS.badStyle]]) {
    const ctx = await newContext(browser2, "cr", { lsValue: val })
    const page = await ctx.newPage()
    const errs = tapConsole(page)
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1500)
    const { crashed, attrs } = await probe(page)
    const hardErrs = errs.filter((e) => e.includes("PAGEERROR") || e.includes("Minified React error") || e.includes("#130"))
    const otherErrs = errs.filter((e) => !e.includes("401"))
    check(`cr-login-${key}-a`, `登录页(AuthShell)·${key}：无崩溃且循环按钮健康`, !crashed && !!attrs.cycleBtn?.hasSvg && hardErrs.length === 0 && otherErrs.length === 0, { cycleBtn: attrs.cycleBtn, hardErrs, otherErrs })
    check(`cr-login-${key}-b`, `登录页(AuthShell)·${key}：data-theme=nova`, attrs.dataTheme === "nova", attrs.dataTheme)
    await page.screenshot({ path: `${SHOTS}/login-${key}.png` })
    await ctx.close()
  }
  await browser2.close()
}

// ============ 验收项3：合法值行为不变（UI 真点：循环按钮 + 设置页风格切换） ============
{
  const browser3 = await chromium.launch({ headless: true })
  const ctx = await browser3.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/qa-223/state.json" })
  const page = await ctx.newPage()
  const net = tapNetwork(page)
  const errs = tapConsole(page)

  // 3-1 预置合法 nova+light → 读页应原样应用（登录态下服务端=nova，不冲突）
  await ctx.addInitScript(() => {
    localStorage.setItem("ciki-theme", JSON.stringify({ state: { theme: "light", style: "nova" }, version: 0 }))
  })
  await page.goto(READ_URL, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  let attrs = (await probe(page)).attrs
  check("f3-a", "项3 合法值 nova+light 原样应用（data-theme=nova/data-mode=light）", attrs.dataTheme === "nova" && attrs.dataMode === "light", { dataTheme: attrs.dataTheme, dataMode: attrs.dataMode })
  const btnSel = 'button[title*="主题："]'
  const title0 = await page.getAttribute(btnSel, "title")
  check("f3-a2", "项3 循环按钮初始提示=浅色（合法值生效）", /(浅色|Light)/i.test(title0 ?? ""), title0)

  // 3-2 循环按钮点击：浅色 → 深色 → 自动（回环）→ 浅色，DOM 跟随
  await page.click(btnSel) // light -> dark
  await page.waitForTimeout(300)
  let attrs1 = (await probe(page)).attrs
  await page.screenshot({ path: `${SHOTS}/f3-cycle-dark.png` })
  check("f3-b", "项3 循环点击1：浅色→深色（data-mode=dark, .dark 挂上）", attrs1.dataMode === "dark" && attrs1.dark === true, attrs1)
  await page.click(btnSel) // dark -> auto（系统亮 → light）
  await page.waitForTimeout(300)
  let attrs2 = (await probe(page)).attrs
  const title2 = await page.getAttribute(btnSel, "title")
  check("f3-c", "项3 循环点击2：深色→自动（跟随系统=亮）", attrs2.dataMode === "light" && /(自动|Auto)/i.test(title2 ?? ""), { ...attrs2, title: title2 })
  await page.click(btnSel) // auto -> light
  await page.waitForTimeout(300)
  let attrs3 = (await probe(page)).attrs
  check("f3-d", "项3 循环点击3：自动→浅色，回环完整", attrs3.dataMode === "light", attrs3)
  // localStorage 持久化正确（循环按钮走 setTheme → persist 写回）
  const lsAfterCycle = attrs3.ls?.state
  check("f3-e", "项3 循环后 localStorage 持久化 theme=light/style=nova", lsAfterCycle?.theme === "light" && lsAfterCycle?.style === "nova", lsAfterCycle)

  // 3-3 设置页风格切换：Nova ↔ 纸面（真点 radio + 保存），服务端为准
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1200)
  const paperRadio = page.getByRole("radio", { name: /纸面|Paper/i }).first()
  await paperRadio.click()
  await page.waitForTimeout(300)
  const saveBtn = page.getByRole("button", { name: /保存|Save/ }).first()
  await saveBtn.click()
  await page.waitForTimeout(1200)
  attrs = (await probe(page)).attrs
  check("f3-f", "项3 设置页切纸面：data-theme=paper", attrs.dataTheme === "paper", attrs.dataTheme)
  const putPaper = net.filter((e) => e.p === "/api/me/theme" && e.m === "PUT" && e.s === 200)
  check("f3-g", "项3 保存触发 PUT /api/me/theme 200（服务端为准）", putPaper.length >= 1, putPaper)
  // 刷新后仍纸面（服务端为准 + 落标）
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  attrs = (await probe(page)).attrs
  check("f3-h", "项3 刷新后保持纸面（不回弹 nova）", attrs.dataTheme === "paper", attrs.dataTheme)
  // 切回 nova
  await page.getByRole("radio", { name: /Nova/i }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole("button", { name: /保存|Save/ }).first().click()
  await page.waitForTimeout(1200)
  attrs = (await probe(page)).attrs
  check("f3-i", "项3 切回 Nova：data-theme=nova", attrs.dataTheme === "nova", attrs.dataTheme)
  check("f3-j", "项3 全程无 pageerror/#130", errs.filter((e) => e.includes("#130") || e.includes("PAGEERROR")).length === 0, errs)
  await page.screenshot({ path: `${SHOTS}/f3-settings-back-nova.png` })

  // 3-4 合法值经 localStorage 直写（dark+paper）在【登录前】读页原样应用
  const ctxB = await browser3.newContext({ viewport: { width: 1440, height: 900 } })
  await ctxB.addInitScript(() => {
    localStorage.setItem("ciki-theme", JSON.stringify({ state: { theme: "dark", style: "paper" }, version: 0 }))
  })
  const pageB = await ctxB.newPage()
  await pageB.goto(READ_URL, { waitUntil: "domcontentloaded" })
  // 未登录会被守卫带到 /login —— 主题属性仍应反映合法值（paper+深色由系统/主题决定）
  await pageB.waitForTimeout(1200)
  const probeB = (await probe(pageB)).attrs
  check("f3-k", "项3 合法值 dark+paper（未登录路由守卫页）：data-theme=paper", probeB.dataTheme === "paper", probeB)
  await pageB.screenshot({ path: `${SHOTS}/f3-legal-paper-dark-login.png` })
  await ctxB.close()

  await browser3.close()
}

// ============ 汇总 ============
fs.mkdirSync("/tmp/qa-223", { recursive: true })
fs.writeFileSync(RESULTS, JSON.stringify({ when: new Date().toISOString(), base: BASE, pageId: PAGE_ID, checks }, null, 2))
const pass = checks.filter((c) => c.pass).length
console.log(`\n==== ${pass}/${checks.length} PASS ====`)
process.exit(pass === checks.length ? 0 : 1)
