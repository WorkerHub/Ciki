/**
 * QA #219：设置页语言分区「暂存 + 独立保存」Jim 真跑（测线 ciki.oneboy.app @ v1.0.0-290-c1392de）
 * 5 项验收逐断言 try/catch，全程 API/console 日志，截图留证。
 * 口令从 /tmp/ciki-qa219/.secret 读，不落日志、不落报告。
 */
const { chromium } = require("playwright-core")
const fs = require("fs")
const os = require("os")
const path = require("path")

const BASE = "https://ciki.oneboy.app"
const OUT = "/tmp/ciki-qa219"
const SHOTS = path.join(OUT, "shots")
const QA_EMAIL = "qa219@qa219.test"
const QA_PASSWORD = fs.readFileSync(path.join(OUT, ".secret"), "utf8").trim()

const CHROME_CANDIDATES = [
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  ),
  path.join(
    os.homedir(),
    "Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"
  )
]

const results = []
const apiLog = []
const consoleErrors = []
let shotSeq = 0

function rec(no, name, pass, detail) {
  const at = new Date().toISOString().slice(11, 19)
  results.push({ no, name, pass, detail, at })
  console.log(`${pass ? "PASS" : "FAIL"} [${no}] ${name} :: ${detail}  @${at}`)
}

async function scrollToLangCard(page, lang) {
  const t = lang === "en" ? "Language" : "语言"
  const card = page.locator('[data-slot="card"]').filter({ has: page.locator(`[data-slot="card-title"]`, { hasText: new RegExp(`^${t}$`) }) })
  await card.scrollIntoViewIfNeeded().catch(() => {})
  return card
}

async function shot(page, label) {
  shotSeq += 1
  const file = path.join(SHOTS, `${String(shotSeq).padStart(2, "0")}-${label}.png`)
  try {
    await page.screenshot({ path: file, fullPage: false })
    return file
  } catch (e) {
    return `screenshot-failed: ${e.message}`
  }
}

async function assertStep(no, name, fn) {
  try {
    const detail = await fn()
    rec(no, name, true, typeof detail === "string" ? detail : "ok")
    return true
  } catch (e) {
    rec(no, name, false, e.message)
    return false
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function expectEq(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

async function installLogging(page, tag) {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push({ tag, text: m.text().slice(0, 300) })
  })
  page.on("pageerror", (e) => consoleErrors.push({ tag, text: `pageerror ${String(e).slice(0, 300)}` }))
  page.on("request", (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith("/api/")) {
      apiLog.push({ tag, t: Date.now(), method: r.method(), path: u.pathname + u.search })
    }
  })
  page.on("response", (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith("/api/")) {
      apiLog.push({ tag, t: Date.now(), method: r.request().method(), path: u.pathname, status: r.status() })
    }
  })
}

/** 语言分区定位：radiogroup(aria-label 界面语言) + 卡内保存按钮。按当前语言取词。 */
function langLocators(page, lang) {
  const groupLabel = lang === "en" ? "Language" : "界面语言"
  const saveText = lang === "en" ? /^(Save|Saving…)$/ : /^(保存|保存中…)$/
  const group = page.getByRole("radiogroup", { name: groupLabel })
  const saveBtn = page
    .locator('[data-slot="card"]')
    .filter({ has: group })
    .getByRole("button", { name: saveText })
  return { group, saveBtn }
}

const radioOf = (group, lang, code) =>
  group.getByRole("radio", { name: code === "en" ? "English" : "中文" })

async function fetchMe(page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/me", { credentials: "include", cache: "no-store" })
    const body = await r.json()
    return { status: r.status, body }
  })
}

async function loginUI(page, email, password) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" })
  await page.waitForSelector("#login-email", { state: "visible", timeout: 20000 })
  await page.fill("#login-email", email)
  await page.fill("#login-password", password)
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/auth/login"), { timeout: 20000 }),
    page.getByRole("button", { name: "登录", exact: true }).click()
  ])
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 })
}

async function gotoSettings(page) {
  await page.goto(BASE + "/settings", { waitUntil: "domcontentloaded" })
  await page.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 20000 })
}

async function main() {
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
  if (!executablePath) throw new Error("no chrome for testing binary")
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    proxy: { server: "http://127.0.0.1:7890" }
  })

  // ===== Context A：主浏览器（登录态）=====
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  })
  const pageA = await ctxA.newPage()
  await installLogging(pageA, "A")

  // 登录（真实 UI 表单）
  await loginUI(pageA, QA_EMAIL, QA_PASSWORD)
  const storedAfterLogin = await pageA.evaluate(() => localStorage.getItem("ciki-language"))
  console.log(`[fact] 登录后 localStorage ciki-language=${storedAfterLogin}`)

  // ---------- 项1：暂存行为 ----------
  await gotoSettings(pageA)
  const L1 = langLocators(pageA, "zh")
  await scrollToLangCard(pageA, "zh")
  await shot(pageA, "s1-settings-zh-initial")

  const zhRadio = radioOf(L1.group, "zh", "zh")
  const enRadio = radioOf(L1.group, "zh", "en")

  await assertStep("1a", "初始：界面中文，分区选中「中文」，保存按钮禁用", async () => {
    expect(await zhRadio.getAttribute("aria-checked") === "true", "中文 radio 未选中")
    expect((await L1.saveBtn.count()) === 1, "语言卡内保存按钮未找到")
    expect(await L1.saveBtn.isDisabled(), "初始保存按钮应禁用")
    // 界面语言为中文的事实：语言卡标题「语言」存在
    expect(await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).count() >= 1, "语言卡标题「语言」不可见")
    return "选中=中文，保存禁用，标题=语言"
  })

  let profileRequests = 0
  await assertStep("1b", "点选 English：界面语言不变、暂存高亮 English、保存按钮变可点、无 profile 请求", async () => {
    const putsBefore = apiLog.filter((e) => e.method === "PUT" && e.path.startsWith("/api/me/profile")).length
    await enRadio.click()
    await pageA.waitForTimeout(300)
    expect(await enRadio.getAttribute("aria-checked") === "true", "English radio 未选中")
    expect(await zhRadio.getAttribute("aria-checked") === "false", "中文 radio 仍选中")
    // 界面语言未变：语言卡标题仍是中文「语言」
    expect(await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).count() >= 1, "界面语言被立即切换（标题非「语言」）")
    expect(!(await L1.saveBtn.isDisabled()), "保存按钮应可点")
    const putsAfter = apiLog.filter((e) => e.method === "PUT" && e.path.startsWith("/api/me/profile")).length
    expectEq(putsAfter - putsBefore, 0, "暂存阶段不应有 PUT /api/me/profile")
    await scrollToLangCard(pageA, "zh")
    await shot(pageA, "s1-staged-en-save-enabled")
    return "暂存高亮 English；标题仍「语言」；保存可点；无 PUT"
  })

  await assertStep("1c", "点回 中文：保存按钮恢复禁用", async () => {
    await zhRadio.click()
    await pageA.waitForTimeout(200)
    expect(await L1.saveBtn.isDisabled(), "点回当前语言后保存按钮应禁用")
    await enRadio.click() // 重新暂存 English，为项2 做准备
    await pageA.waitForTimeout(200)
    expect(!(await L1.saveBtn.isDisabled()), "重新暂存 English 后保存按钮应可点")
    return "回中文→禁用；再点 English→可点（可重复）"
  })

  // ---------- 项2：保存生效 + 账号写回 ----------
  await assertStep("2a", "点保存：PUT /api/me/profile 200，界面语言立即切换为英文，保存按钮回到禁用", async () => {
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/api/me/profile") && r.request().method() === "PUT", { timeout: 15000 }),
      L1.saveBtn.click({ timeout: 8000 })
    ])
    expectEq(resp.status(), 200, "PUT /api/me/profile 状态码")
    await pageA.locator('[data-slot="card-title"]', { hasText: /^Language$/ }).first().waitFor({ state: "visible", timeout: 10000 })
    const L2 = langLocators(pageA, "en")
    expect(await L2.group.getByRole("radio", { name: "English" }).getAttribute("aria-checked") === "true", "英文分区未选中")
    await pageA.waitForTimeout(300)
    expect(await L2.saveBtn.isDisabled(), "保存成功后保存按钮应回到禁用")
    const stored = await pageA.evaluate(() => localStorage.getItem("ciki-language"))
    expectEq(stored, "en", "localStorage ciki-language")
    await scrollToLangCard(pageA, "en")
    await shot(pageA, "s2-saved-en")
    return "PUT 200；标题 Language；按钮回禁用；localStorage=en"
  })

  await assertStep("2b", "刷新后保持英文（RootGate 以账号语言覆盖）", async () => {
    await pageA.reload({ waitUntil: "domcontentloaded" })
    await pageA.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 20000 })
    expect(await pageA.locator('[data-slot="card-title"]', { hasText: /^Language$/ }).count() >= 1, "刷新后语言卡标题非 Language")
    expect(await langLocators(pageA, "en").group.getByRole("radio", { name: "English" }).getAttribute("aria-checked") === "true", "刷新后分区未选中 English")
    await shot(pageA, "s2-refresh-en")
    return "刷新后界面=英文，分区=English"
  })

  await assertStep("2c", "服务端已写回：GET /api/me 返回 language=en（接口层证据）", async () => {
    const { status, body: me } = await fetchMe(pageA)
    expectEq(status, 200, "GET /api/me 状态码")
    expectEq(me.language, "en", "GET /api/me language")
    return `GET /api/me language=${me.language} (id=${me.id}, raw=${JSON.stringify({ language: me.language, id: me.id })})`
  })

  // 换浏览器：全新 context（无 cookie / 无 storage），真实 UI 登录同账号
  const ctxB = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  })
  const pageB = await ctxB.newPage()
  await installLogging(pageB, "B")

  await assertStep("2d", "换浏览器登录同账号：界面语言为保存后的英文（账号已写回）", async () => {
    await loginUI(pageB, QA_EMAIL, QA_PASSWORD)
    await pageB.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {})
    // 登录后落在首页（AppShell）。语言卡标题不在首页——用稳定中文案断言：此时界面应为英文
    const titleEn = await pageB.locator('[data-slot="card-title"]', { hasText: /^Language$/ }).count()
    await pageB.goto(BASE + "/settings", { waitUntil: "domcontentloaded" })
    await pageB.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 20000 })
    expect(await pageB.locator('[data-slot="card-title"]', { hasText: /^Language$/ }).count() >= 1, "换浏览器登录后语言卡标题非 Language")
    expect(await langLocators(pageB, "en").group.getByRole("radio", { name: "English" }).getAttribute("aria-checked") === "true", "换浏览器登录后分区未选中 English")
    const { status, body: me } = await fetchMe(pageB)
    expectEq(status, 200, "GET /api/me 状态码")
    expectEq(me.language, "en", "换浏览器 GET /api/me language")
    await scrollToLangCard(pageB, "en")
    await shot(pageB, "s2-new-browser-en")
    return "新 context 登录后界面=英文；/api/me language=en"
  })
  await ctxB.close()

  // 恢复：Context A 切回中文并保存（顺带验证反向保存链）
  await assertStep("2e", "反向保存链：切回中文并保存成功（为项3/4 复位基线）", async () => {
    const L2 = langLocators(pageA, "en")
    const zhBack = L2.group.getByRole("radio", { name: "中文" })
    await zhBack.click()
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/api/me/profile") && r.request().method() === "PUT", { timeout: 15000 }),
      L2.saveBtn.click({ timeout: 8000 })
    ])
    expectEq(resp.status(), 200, "PUT 状态码")
    await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).first().waitFor({ state: "visible", timeout: 10000 })
    expectEq(await pageA.evaluate(() => localStorage.getItem("ciki-language")), "zh", "localStorage ciki-language")
    const { status, body: me } = await fetchMe(pageA)
    expectEq(status, 200, "GET /api/me 状态码")
    expectEq(me.language, "zh", "GET /api/me language")
    return "PUT 200；界面回中文；localStorage=zh；/api/me language=zh"
  })

  // ---------- 项3：断网下保存失败回滚 ----------
  // context 级 route：只 abort PUT /api/me/profile，其余放行（记忆：context 级 + 守卫最稳）
  let netCut = false
  await ctxA.route("**/*", (route) => {
    const req = route.request()
    try {
      const u = new URL(req.url())
      if (
        netCut &&
        u.host === "ciki.oneboy.app" &&
        req.method() === "PUT" &&
        u.pathname === "/api/me/profile"
      ) {
        return route.abort("internetdisconnected")
      }
      return route.continue()
    } catch (e) {
      return route.abort("failed")
    }
  })

  await assertStep("3a", "断网下点保存：出现错误提示（role=alert 网络异常）", async () => {
    const L1 = langLocators(pageA, "zh")
    await L1.group.getByRole("radio", { name: "English" }).click()
    netCut = true
    const [respOrAbort] = await Promise.all([
      pageA.waitForEvent("requestfailed", (r) => r.url().includes("/api/me/profile") && r.method() === "PUT", { timeout: 15000 }),
      L1.saveBtn.click({ timeout: 8000 })
    ])
    expect(respOrAbort.failure() && respOrAbort.failure().errorText, "请求未按预期失败")
    const alert = pageA.getByRole("alert")
    await alert.first().waitFor({ state: "visible", timeout: 10000 })
    const alertText = (await alert.first().textContent()) || ""
    expect(alertText.includes("网络异常"), `错误提示文案不含「网络异常」: ${alertText}`)
    await shot(pageA, "s3-offline-alert")
    return `PUT aborted(${respOrAbort.failure().errorText})；alert=「${alertText.trim()}」`
  })

  await assertStep("3b", "界面语言回滚为保存前的中文，localStorage 复位，账号未写回", async () => {
    await pageA.waitForTimeout(500)
    expect(await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).count() >= 1, "界面语言未回滚为中文")
    const stored = await pageA.evaluate(() => localStorage.getItem("ciki-language"))
    expectEq(stored, "zh", "localStorage 应回滚为 zh")
    const { status, body: me } = await fetchMe(pageA)
    expectEq(status, 200, "GET /api/me 状态码")
    expectEq(me.language, "zh", "账号 language 未被写回（应仍为 zh）")
    await scrollToLangCard(pageA, "zh")
    await shot(pageA, "s3-rolled-back-zh")
    return "标题=语言；localStorage=zh；/api/me language=zh"
  })

  await assertStep("3c", "回滚后保存按钮保持可点（暂存仍在，可重试），恢复网络后保存可成功", async () => {
    const L1 = langLocators(pageA, "zh")
    expect(!(await L1.saveBtn.isDisabled()), "失败回滚后保存按钮应保持可点")
    netCut = false // 恢复网络
    const [resp] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/api/me/profile") && r.request().method() === "PUT", { timeout: 15000 }),
      L1.saveBtn.click({ timeout: 8000 })
    ])
    expectEq(resp.status(), 200, "恢复后 PUT 状态码")
    await pageA.locator('[data-slot="card-title"]', { hasText: /^Language$/ }).first().waitFor({ state: "visible", timeout: 10000 })
    // 再恢复回中文基线（项4 需要 zh 起点）
    const L2 = langLocators(pageA, "en")
    await L2.group.getByRole("radio", { name: "中文" }).click()
    const [resp2] = await Promise.all([
      pageA.waitForResponse((r) => r.url().includes("/api/me/profile") && r.request().method() === "PUT", { timeout: 15000 }),
      L2.saveBtn.click({ timeout: 8000 })
    ])
    expectEq(resp2.status(), 200, "复位 PUT 状态码")
    await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).first().waitFor({ state: "visible", timeout: 10000 })
    return "失败后按钮可点；恢复网络重试 200；已复位 zh"
  })

  // ---------- 项4：未保存直接离开设置页再回来 ----------
  await assertStep("4a", "暂存 English 后暂存不落盘（localStorage 仍 zh）", async () => {
    const L1 = langLocators(pageA, "zh")
    await L1.group.getByRole("radio", { name: "English" }).click()
    await pageA.waitForTimeout(200)
    const stored = await pageA.evaluate(() => localStorage.getItem("ciki-language"))
    expectEq(stored, "zh", "未保存时 localStorage 不应被暂存污染")
    return "暂存 English 后 localStorage 仍 zh"
  })

  await assertStep("4b", "未保存直接离开（账号菜单→个人资料，SPA 导航）再回设置：暂存不残留", async () => {
    // 通过账号菜单真实导航离开
    await pageA.getByRole("button", { name: "账号菜单" }).click()
    await pageA.getByRole("menuitem", { name: "个人资料" }).click()
    await pageA.waitForURL((u) => u.pathname === "/profile", { timeout: 15000 })
    await pageA.waitForTimeout(400)
    await shot(pageA, "s4-left-to-profile")
    // 再回设置
    await pageA.getByRole("button", { name: "账号菜单" }).click()
    await pageA.getByRole("menuitem", { name: "设置" }).click()
    await pageA.waitForURL((u) => u.pathname === "/settings", { timeout: 15000 })
    await pageA.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 15000 })
    await pageA.waitForTimeout(300)
    const L1 = langLocators(pageA, "zh")
    expect(await L1.group.getByRole("radio", { name: "中文" }).getAttribute("aria-checked") === "true", "回到设置页后分区应回到当前语言「中文」")
    expect(await L1.saveBtn.isDisabled(), "暂存不残留：保存按钮应禁用")
    expect(await pageA.locator('[data-slot="card-title"]', { hasText: /^语言$/ }).count() >= 1, "界面语言应为中文")
    await scrollToLangCard(pageA, "zh")
    await shot(pageA, "s4-back-staged-dropped")
    return "离开→/profile→回 /settings：选中=中文，保存禁用，界面中文"
  })

  await assertStep("4c", "整页刷新路径同样不残留：暂存后 reload，回原值", async () => {
    const L1 = langLocators(pageA, "zh")
    await L1.group.getByRole("radio", { name: "English" }).click()
    await pageA.waitForTimeout(200)
    await pageA.reload({ waitUntil: "domcontentloaded" })
    await pageA.getByRole("radiogroup").first().waitFor({ state: "visible", timeout: 20000 })
    await pageA.waitForTimeout(300)
    const L = langLocators(pageA, "zh")
    expect(await L.group.getByRole("radio", { name: "中文" }).getAttribute("aria-checked") === "true", "reload 后分区应回「中文」")
    expect(await L.saveBtn.isDisabled(), "reload 后保存按钮应禁用")
    const { status, body: me } = await fetchMe(pageA)
    expectEq(status, 200, "GET /api/me 状态码")
    expectEq(me.language, "zh", "账号 language 全程未被项4 触碰")
    return "暂存→reload→中文/禁用；/api/me language=zh"
  })

  await ctxA.close()

  // ---------- 项5：未登录页语言循环按钮（全新未登录 context）----------
  const ctxC = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai"
  })
  const pageC = await ctxC.newPage()
  await installLogging(pageC, "C")

  await assertStep("5a", "未登录页循环按钮存在，当前态=中文，点击立即切英文（无暂存/无保存按钮）", async () => {
    await pageC.goto(BASE + "/", { waitUntil: "domcontentloaded" })
    await pageC.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 20000 })
    const cycle = pageC.getByRole("button", { name: /界面语言：.+，点击切换|Language: .+\. Click to switch\./ })
    await cycle.waitFor({ state: "visible", timeout: 15000 })
    const initialLabel = await cycle.getAttribute("aria-label")
    expect(initialLabel.includes("中文"), `初始循环按钮态应为中文: ${initialLabel}`)
    // 现状行为：点击立即生效（登录页标题/文案变英文），且无保存按钮出现
    await cycle.click()
    await pageC.waitForTimeout(400)
    const label = await cycle.getAttribute("aria-label")
    expect(label.includes("English"), `点击后按钮态应为 English: ${label}`)
    expect(await pageC.getByRole("button", { name: "Sign in", exact: true }).count() === 1, "登录按钮未变英文（点击未立即生效）")
    expect((await pageC.getByRole("button", { name: /^(保存|保存中…)$/ }).count()) === 0, "未登录页不应出现保存按钮")
    await shot(pageC, "s5-login-en")
    return "点击立即 zh→en；登录按钮变 Sign in；无保存按钮"
  })

  await assertStep("5b", "循环顺序与保持：刷新仍英文（localStorage），再点回到中文", async () => {
    expectEq(await pageC.evaluate(() => localStorage.getItem("ciki-language")), "en", "循环选择应写 localStorage（现状行为）")
    await pageC.reload({ waitUntil: "domcontentloaded" })
    const cycle = pageC.getByRole("button", { name: /界面语言：.+，点击切换|Language: .+\. Click to switch\./ })
    await cycle.waitFor({ state: "visible", timeout: 15000 })
    expect((await cycle.getAttribute("aria-label")).includes("English"), "刷新后循环按钮态应保持 English")
    await cycle.click()
    await pageC.waitForTimeout(400)
    expect((await cycle.getAttribute("aria-label")).includes("中文"), "第二次点击应回到中文（循环 zh→en→zh）")
    expect(await pageC.getByRole("button", { name: "登录", exact: true }).count() === 1, "回到中文后登录按钮文案应恢复「登录」")
    await shot(pageC, "s5-login-back-zh")
    return "刷新保持 en；再点回 zh；循环顺序正确"
  })

  await ctxC.close()
  await browser.close()

  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ results, apiLog, consoleErrors, finishedAt: new Date().toISOString() }, null, 2)
  )
  const failed = results.filter((r) => !r.pass)
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`)
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.no).join(", "))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exitCode = 2
}).finally(() => {
  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ results, apiLog, consoleErrors, finishedAt: new Date().toISOString() }, null, 2)
  )
  console.log("results.json written")
})
