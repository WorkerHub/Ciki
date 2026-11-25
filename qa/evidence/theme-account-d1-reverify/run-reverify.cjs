/**
 * Ciki 主题风格·验收补测（#211）：D1 修复（876447f，migratedAt 持久化标记）后重验
 *   项2 服务端为准（D1 原回归场景）+ 项4 一次性迁移（仍生效、仅一次）+ 修复口径三核对点。
 * 方法沿用 #194（Jim 真跑）：Playwright chromium 真浏览器、真实 UI 操作、/api 网络捕获、
 *   localStorage 断言、逐步截图；口令从 /tmp/ciki-qa-jim.pw 读取，绝不打印/落证据。
 * 前置（bash 预置，见同目录 README）：
 *   - 本地栈 http://127.0.0.1:9465 与生产同 commit（v1.0.0-289-876447f）
 *   - 账号 qa-jim-theme@example.com 已注册（沿用 #194 凭据），服务端 themeStyle 复位为 nova（默认）
 * 环境发现：PWA SW（web/public/sw.js）fetch 直通 → 页面请求由 SW 代发，page.route 拦不到；
 *   失败注入用 serviceWorkers:'block' 上下文（sw.js 注册失败已被 main.tsx 捕获，无副作用）。
 * 证据输出：本目录 JSON + 截图；摘要打印 stdout。
 */
const { chromium } = require("/tmp/ciki-qa-jim/node_modules/playwright-core")
const fs = require("fs")
const path = require("path")

const BASE = "http://127.0.0.1:9465"
const EMAIL = "qa-jim-theme@example.com"
const PW = fs.readFileSync("/tmp/ciki-qa-jim.pw", "utf8").trim()
const EV = __dirname
const STAMP = new Date().toISOString()

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name} :: ${JSON.stringify(detail)}`)
}

/** /api 网络捕获（append-only）：登录类请求体一律脱敏丢弃。 */
function netTap(page) {
  const log = []
  page.on("response", async (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith("/api/")) return
    const entry = {
      method: r.request().method(),
      path: u.pathname,
      status: r.status(),
      post: null
    }
    if (u.pathname === "/api/me" || u.pathname.startsWith("/api/me/theme")) {
      try {
        entry.respBody = await r.json()
      } catch {}
    }
    if (entry.method === "PUT" && u.pathname === "/api/me/theme") {
      entry.post = r.request().postData() // {"themeStyle":"..."}，无敏感字段
    }
    log.push(entry)
  })
  return log
}
const putThemeCount = (log, upto) =>
  log
    .slice(0, upto ?? log.length)
    .filter((e) => e.method === "PUT" && e.path === "/api/me/theme").length

/**
 * console error 必须逐条对应网络日志里的 401（未登录探活）与人为注入的网络失败
 * （abort 会留一条 net::ERR_FAILED，条数 = injectFailed 次数），不得有其他任何错误。
 */
function onlyExpected401(errors, net, injectFailed = 0) {
  const count401 = net.filter((e) => e.status === 401).length
  const allAreExpected = errors.consoleErrors.every(
    (m) => m.includes("401 (Unauthorized)") || m.includes("net::ERR_FAILED")
  )
  const errFailed = errors.consoleErrors.filter((m) =>
    m.includes("net::ERR_FAILED")
  ).length
  return {
    ok:
      errors.pageErrors.length === 0 &&
      allAreExpected &&
      errors.consoleErrors.length === count401 + injectFailed &&
      errFailed === injectFailed,
    pageErrors: errors.pageErrors,
    consoleErrors: errors.consoleErrors,
    net401Count: count401,
    injectFailed,
    net401s: net
      .filter((e) => e.status === 401)
      .map((e) => ({ method: e.method, path: e.path, status: e.status }))
  }
}

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    ...opts
  })
  const page = await ctx.newPage()
  const errors = { pageErrors: [], consoleErrors: [] }
  page.on("pageerror", (e) => errors.pageErrors.push(String(e)))
  page.on("console", (m) => {
    if (m.type() === "error") errors.consoleErrors.push(m.text())
  })
  return { ctx, page, errors }
}

async function themeState(page, withBtn = true) {
  return page.evaluate((withBtn) => {
    const html = document.documentElement
    const btn = document.querySelector('button[aria-label^="主题："]')
    const lsRaw = localStorage.getItem("ciki-theme")
    let ls = null
    try {
      ls = lsRaw ? JSON.parse(lsRaw) : null
    } catch {
      ls = "PARSE_FAIL:" + lsRaw
    }
    const r = {
      dataTheme: html.getAttribute("data-theme"),
      dataMode: html.getAttribute("data-mode"),
      localStorage: ls
    }
    if (withBtn) {
      r.cycleBtnPresent = !!btn
      r.cycleBtnLabel = btn ? btn.getAttribute("aria-label") : null
    }
    return r
  }, withBtn)
}

const meFetch = (page) =>
  page.evaluate(() => fetch("/api/me").then((r) => r.json()))

async function uiLogin(page, email = EMAIL) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#login-email", { timeout: 15000 })
  await page.fill("#login-email", email)
  await page.fill("#login-password", PW)
  await page.getByRole("button", { name: "登录", exact: true }).click()
  await page.waitForURL(
    (u) => u.pathname === "/" || u.pathname.startsWith("/s/"),
    { timeout: 15000 }
  )
  await page.waitForTimeout(1000)
}

async function settingsPage(page) {
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector('[data-slot="card"]', { timeout: 15000 })
  await page.waitForTimeout(300)
}

async function waitSaveNotice(page) {
  await page
    .getByRole("status")
    .filter({ hasText: "主题风格已保存" })
    .waitFor({ timeout: 10000 })
}

/** 保存风格（UI）：点选 radio → 保存 → 等成功提示。 */
async function uiSaveStyle(page, choice) {
  await page.getByRole("radio", { name: choice }).click()
  const save = page.getByRole("button", { name: "保存" })
  await save.waitFor({ timeout: 8000 })
  if (await save.isDisabled())
    throw new Error(`保存按钮仍禁用（选择 ${choice} 后无变化？）`)
  await save.click()
  await waitSaveNotice(page)
  await page.waitForTimeout(400)
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(EV, name), fullPage: false })
}

/** 项4 用的「升级前老用户」本地镜像种子：本地 paper、从未迁移。 */
const SEED_OLD_USER = JSON.stringify({
  state: { theme: "auto", style: "paper", migratedAt: null },
  version: 0
})

;(async () => {
  /* ================= 项2：服务端为准（D1 原回归场景） ================= */
  // 阶段 a：B1 登录（全新上下文，本地无镜像）→ 基线：默认 nova、无回写
  const browser1 = await chromium.launch()
  const browser2 = await chromium.launch()
  const b1 = await newPage(browser1)
  const b2 = await newPage(browser2)
  const net1 = netTap(b1.page)
  const net2 = netTap(b2.page)

  await uiLogin(b1.page)
  const st0 = await themeState(b1.page)
  const me0 = await meFetch(b1.page)
  record(
    "项2-a B1 登录基线：服务端 nova、本地无镜像、未触发任何回写",
    me0.themeStyle === "nova" &&
      st0.localStorage === null &&
      st0.dataTheme === "nova" &&
      putThemeCount(net1) === 0,
    { themeState: st0, server: me0.themeStyle, putCount: putThemeCount(net1) }
  )

  // 阶段 b：B1 设置页保存纸面 —— 核对点「设置页保存成功也落标 migratedAt」
  await settingsPage(b1.page)
  await shot(b1.page, "10-item2-b1-settings-before.png")
  await uiSaveStyle(b1.page, "纸面")
  const st1 = await themeState(b1.page)
  const put1 = net1.filter(
    (e) => e.method === "PUT" && e.path === "/api/me/theme"
  ).pop()
  const me1 = await meFetch(b1.page)
  const lsOk1 =
    st1.localStorage &&
    st1.localStorage.state?.style === "paper" &&
    typeof st1.localStorage.state?.migratedAt === "number"
  record(
    "项2-b B1 保存纸面成功：PUT 200 + 服务端 paper + UI/镜像 paper + migratedAt 落标（设置页保存成功落标）",
    put1?.status === 200 &&
      put1?.respBody?.themeStyle === "paper" &&
      me1.themeStyle === "paper" &&
      st1.dataTheme === "paper" &&
      lsOk1,
    { put: put1, server: me1.themeStyle, themeState: st1 }
  )
  await shot(b1.page, "11-item2-b1-saved-paper.png")

  // 阶段 c：B2（独立浏览器进程）登录同账号 → 自动应用服务端 paper，无回写
  await uiLogin(b2.page)
  const st2 = await themeState(b2.page)
  const me2 = await meFetch(b2.page)
  record(
    "项2-c B2 登录自动应用服务端 paper（跨浏览器一致），且 B2 未回写",
    st2.dataTheme === "paper" &&
      st2.localStorage?.state?.style === "paper" &&
      me2.themeStyle === "paper" &&
      putThemeCount(net2) === 0,
    { themeState: st2, server: me2.themeStyle, putCount: putThemeCount(net2) }
  )

  // 阶段 d：B2 改回 Nova 保存（项2 的触发动作）
  await settingsPage(b2.page)
  await shot(b2.page, "12-item2-b2-settings-before.png")
  await uiSaveStyle(b2.page, "Nova")
  const st3 = await themeState(b2.page)
  const put2 = net2.filter(
    (e) => e.method === "PUT" && e.path === "/api/me/theme"
  ).pop()
  const me3 = await meFetch(b2.page)
  const lsOk3 =
    st3.localStorage &&
    st3.localStorage.state?.style === "nova" &&
    typeof st3.localStorage.state?.migratedAt === "number"
  record(
    "项2-d B2 改回 Nova 保存成功：PUT 200 + 服务端 nova + B2 落标（migratedAt）",
    put2?.status === 200 &&
      put2?.respBody?.themeStyle === "nova" &&
      me3.themeStyle === "nova" &&
      st3.dataTheme === "nova" &&
      lsOk3,
    { put: put2, server: me3.themeStyle, themeState: st3 }
  )
  await shot(b2.page, "13-item2-b2-saved-nova.png")

  // 阶段 e：项2 核心 —— B1（本地镜像 paper、已落标）刷新 → 应用服务端 nova，绝不回写
  const putsBefore = putThemeCount(net1)
  const migratedAtBefore = st1.localStorage.state.migratedAt
  await b1.page.reload({ waitUntil: "domcontentloaded" })
  await b1.page.waitForTimeout(1200)
  const st4 = await themeState(b1.page)
  const me4 = await meFetch(b1.page)
  const putsAfter1 = putThemeCount(net1)
  record(
    "项2-e B1 刷新后应用服务端 nova（服务端为准），全程零回写（D1 缺陷不复现）",
    st4.dataTheme === "nova" &&
      st4.localStorage?.state?.style === "nova" &&
      typeof st4.localStorage?.state?.migratedAt === "number" &&
      me4.themeStyle === "nova" &&
      putsAfter1 === putsBefore,
    {
      themeState: st4,
      server: me4.themeStyle,
      putCountBefore: putsBefore,
      putCountAfter: putsAfter1
    }
  )
  await shot(b1.page, "14-item2-b1-after-reload-nova.png")

  // 阶段 f：再刷一次仍不回写；标记时间戳未被重置
  await b1.page.reload({ waitUntil: "domcontentloaded" })
  await b1.page.waitForTimeout(1200)
  const st5 = await themeState(b1.page)
  const me5 = await meFetch(b1.page)
  const putsAfter2 = putThemeCount(net1)
  record(
    "项2-f B1 二次刷新仍零回写、保持 nova、migratedAt 未被改动",
    st5.dataTheme === "nova" &&
      st5.localStorage?.state?.style === "nova" &&
      st5.localStorage?.state?.migratedAt === migratedAtBefore &&
      me5.themeStyle === "nova" &&
      putsAfter2 === putsBefore,
    {
      themeState: st5,
      server: me5.themeStyle,
      putCount: putsAfter2,
      migratedAtBefore,
      migratedAtAfter: st5.localStorage?.state?.migratedAt
    }
  )

  // 阶段 g：服务端保持 nova 的独立复核（经 B2 会话）
  const me6 = await meFetch(b2.page)
  record(
    "项2-g 独立复核：服务端仍为 nova（B1 未把服务端改回纸面）",
    me6.themeStyle === "nova",
    { server: me6.themeStyle }
  )

  // 阶段 h：两个浏览器全程无 JS 异常；console error 仅限未登录探活的 401（与网络日志吻合）
  const h1 = onlyExpected401(b1.errors, net1)
  const h2 = onlyExpected401(b2.errors, net2)
  record(
    "项2-h B1/B2 全程无 pageerror；console error 逐条对应未登录探活的预期 401",
    h1.ok && h2.ok,
    { b1: h1, b2: h2 }
  )

  await browser1.close()
  await browser2.close()

  /* ================= 项4：一次性迁移（仍生效、仅一次） ================= */
  // 前置：项2 结束态服务端=nova（正好是项4 场景）。B3 全新浏览器进程。
  const browser3 = await chromium.launch()
  const b3 = await newPage(browser3)
  const net3 = netTap(b3.page)

  // 阶段 a：未登录时种入「升级前老用户」本地镜像（paper、从未迁移），首屏内联脚本生效
  await b3.page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" })
  await b3.page.evaluate(
    (seed) => localStorage.setItem("ciki-theme", seed),
    SEED_OLD_USER
  )
  await b3.page.reload({ waitUntil: "domcontentloaded" })
  await b3.page.waitForTimeout(600)
  const st6 = await themeState(b3.page, false)
  record(
    "项4-a B3 种入老用户镜像（style=paper、migratedAt=null），首屏内联脚本应用纸面",
    st6.dataTheme === "paper" &&
      st6.localStorage?.state?.style === "paper" &&
      st6.localStorage?.state?.migratedAt === null,
    { themeState: st6 }
  )
  await shot(b3.page, "20-item4-b3-login-paper-mirror.png")

  // 阶段 b：登录 → 迁移回写一次（PUT paper 200）→ 服务端变 paper + 应用纸面 + 落标
  const puts3Before = putThemeCount(net3)
  await uiLogin(b3.page)
  const st7 = await themeState(b3.page)
  const me7 = await meFetch(b3.page)
  const puts3After = putThemeCount(net3)
  const put3 = net3
    .filter((e) => e.method === "PUT" && e.path === "/api/me/theme")
    .pop()
  const lsOk7 =
    st7.localStorage &&
    st7.localStorage.state?.style === "paper" &&
    typeof st7.localStorage.state?.migratedAt === "number"
  record(
    "项4-b 老用户登录：自动回写纸面恰好一次（PUT 200）+ 服务端变 paper + 应用纸面 + migratedAt 落标（迁移回写成功落标）",
    puts3After - puts3Before === 1 &&
      put3?.status === 200 &&
      put3?.post === JSON.stringify({ themeStyle: "paper" }) &&
      me7.themeStyle === "paper" &&
      st7.dataTheme === "paper" &&
      lsOk7,
    {
      putCountBefore: puts3Before,
      putCountAfter: puts3After,
      put: put3,
      server: me7.themeStyle,
      themeState: st7
    }
  )
  await shot(b3.page, "21-item4-b3-after-login-paper.png")

  // 阶段 c：刷新不再回写（仅一次语义）；标记不被重置
  const migratedAt7 = st7.localStorage.state.migratedAt
  await b3.page.reload({ waitUntil: "domcontentloaded" })
  await b3.page.waitForTimeout(1200)
  const st8 = await themeState(b3.page)
  const me8 = await meFetch(b3.page)
  record(
    "项4-c 迁移后首次刷新：零回写、保持 paper、服务端 paper、migratedAt 未重置",
    putThemeCount(net3) === puts3After &&
      st8.dataTheme === "paper" &&
      st8.localStorage?.state?.migratedAt === migratedAt7 &&
      me8.themeStyle === "paper",
    {
      putCount: putThemeCount(net3),
      server: me8.themeStyle,
      themeState: st8
    }
  )
  await b3.page.reload({ waitUntil: "domcontentloaded" })
  await b3.page.waitForTimeout(1200)
  const st9 = await themeState(b3.page)
  const me9 = await meFetch(b3.page)
  record(
    "项4-d 二次刷新：仍零回写、保持 paper",
    putThemeCount(net3) === puts3After &&
      st9.dataTheme === "paper" &&
      me9.themeStyle === "paper",
    { putCount: putThemeCount(net3), server: me9.themeStyle, themeState: st9 }
  )
  await browser3.close()

  /* ============ 修复口径三：迁移回写失败不落标、保留本地 paper、下次重试 ============ */
  // SW（web/public/sw.js）fetch 直通 → page.route 拦不到页面请求，
  // 失败注入在 serviceWorkers:'block' 上下文（B4）中进行。
  // 状态自然形成：项4 结束态服务端=paper → B4 登录同步本地镜像 paper（else 分支不落标）
  //   → 服务端复位 nova → 得到「服务端 nova + 本地 paper + 未落标」。
  const browser4 = await chromium.launch()
  const b4 = await newPage(browser4, { serviceWorkers: "block" })
  const net4 = netTap(b4.page)

  // 阶段 e：B4 登录（服务端仍 paper）→ 本地镜像同步为 paper、不落标
  await uiLogin(b4.page)
  const stE = await themeState(b4.page)
  const meE = await meFetch(b4.page)
  record(
    "口3-e B4（SW 屏蔽）登录：服务端 paper 同步到本地镜像（else 分支，不落标）",
    stE.dataTheme === "paper" &&
      stE.localStorage?.state?.style === "paper" &&
      stE.localStorage?.state?.migratedAt === null &&
      meE.themeStyle === "paper" &&
      putThemeCount(net4) === 0,
    { themeState: stE, server: meE.themeStyle, putCount: putThemeCount(net4) }
  )

  // 阶段 e-1：服务端复位为 nova（构造「服务端 nova + 本地 paper + 未落标」态）
  const resetResp = await b4.page.evaluate(() =>
    fetch("/api/me/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themeStyle: "nova" })
    }).then((r) => r.json())
  )
  const meR = await meFetch(b4.page)
  record(
    "口3-e1 复位服务端为 nova（构造重试场景前置）",
    resetResp?.themeStyle === "nova" && meR.themeStyle === "nova",
    { resetThemeStyle: resetResp?.themeStyle, server: meR.themeStyle }
  )

  // 阶段 f：拦截 PUT /api/me/theme 直接断网失败 → 刷新 → 迁移尝试失败
  let aborted = 0
  await b4.page.route("**/api/me/theme", (route) => {
    aborted++
    route.abort("failed")
  })
  await b4.page.reload({ waitUntil: "domcontentloaded" })
  await b4.page.waitForTimeout(1200)
  const stF = await themeState(b4.page, false)
  const meF = await meFetch(b4.page)
  record(
    "口3-f 回写失败（网络层 abort 恰 1 次）：不落标（migratedAt 仍 null）+ 保留本地 paper + 服务端未被改",
    aborted === 1 &&
      stF.localStorage?.state?.style === "paper" &&
      stF.localStorage?.state?.migratedAt === null &&
      stF.dataTheme === "paper" &&
      meF.themeStyle === "nova",
    { themeState: stF, server: meF.themeStyle, abortedAttempts: aborted }
  )
  await shot(b4.page, "30-fail-kept-paper-no-marker.png")

  // 阶段 g：解除拦截 → 刷新 → 重试成功（重试至成功语义保留）
  await b4.page.unroute("**/api/me/theme")
  await b4.page.reload({ waitUntil: "domcontentloaded" })
  await b4.page.waitForTimeout(1200)
  const stG = await themeState(b4.page)
  const meG = await meFetch(b4.page)
  const putG = net4
    .filter((e) => e.method === "PUT" && e.path === "/api/me/theme")
    .pop()
  const lsOkG =
    stG.localStorage &&
    stG.localStorage.state?.style === "paper" &&
    typeof stG.localStorage.state?.migratedAt === "number"
  record(
    "口3-g 重试成功：PUT paper 200 + 服务端变 paper + 落标 + 应用纸面",
    putG?.status === 200 &&
      putG?.post === JSON.stringify({ themeStyle: "paper" }) &&
      meG.themeStyle === "paper" &&
      stG.dataTheme === "paper" &&
      lsOkG,
    { put: putG, server: meG.themeStyle, themeState: stG }
  )
  await shot(b4.page, "31-retry-succeeded-marker-set.png")

  // 阶段 h：B3/B4 全程无 pageerror（迁移失败被静默降级、不崩）；
  // B4 的 console error = 预期 401 + 口3-f 人为注入的 1 次 net::ERR_FAILED
  const h3 = onlyExpected401(b3.errors, net3)
  const h4 = onlyExpected401(b4.errors, net4, aborted)
  record(
    "口3-h B3/B4 全程无 pageerror；console error 逐条对应预期 401 与人为注入的失败",
    h3.ok && h4.ok,
    { b3: h3, b4: h4 }
  )

  await browser4.close()

  /* ================= 汇总 ================= */
  const passed = results.filter((r) => r.pass).length
  const summary = {
    stamp: STAMP,
    base: BASE,
    build: "v1.0.0-289-876447f（本地栈与生产同 commit）",
    fix: "876447f fix(theme): persist migration marker to ensure server style precedence (#275)",
    account: EMAIL,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    net: { b1: net1, b2: net2, b3: net3, b4: net4 }
  }
  fs.writeFileSync(
    path.join(EV, "results.json"),
    JSON.stringify(summary, null, 2)
  )
  console.log(`\n==== 汇总：${passed}/${results.length} 通过 ====`)
  for (const r of results) {
    console.log(` ${r.pass ? "✓" : "✗"} ${r.name}`)
  }
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error("SCRIPT_ERROR", e)
  fs.writeFileSync(
    path.join(EV, "results.json"),
    JSON.stringify({ stamp: STAMP, scriptError: String(e), results }, null, 2)
  )
  process.exit(2)
})
