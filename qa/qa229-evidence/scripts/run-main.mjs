// QA #229 主测试（可指向生产或本地）。
// 用法：node run-main.mjs <base-url> <origin-name> [cookieFile] [passwordFile]
//  - cookieFile：真实登录接口所得会话（注入浏览器）；不传则 UI 真实登录（passwordFile）。
// 逐项断言记 PASS/FAIL，最后落 results-<origin>.json + 截图 + apiLog。
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync } from "node:fs"
import { launchOptions, sampleLabel, readLabel } from "./lib.mjs"

const [, , baseUrl, originName, cookieFile, passwordFile] = process.argv
const PAGE_ID = Number(process.env.QA_PAGE_ID || 409)
const EDIT_URL = `${baseUrl}/p/${PAGE_ID}/edit`
const RELOADS = Number(process.env.QA_RELOADS || 10)
const MARK_H2 = "QA229 标题开头"
const MARK_P = "QA229 正文段落"
const OUT = (f) => `/tmp/ciki-qa229/${f}`

const out = { origin: originName, baseUrl, pageId: PAGE_ID, reloads: RELOADS, checks: [], apiLog: [] }
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`)
}

const browser = await chromium.launch(launchOptions())
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  reducedMotion: "reduce"
})
context.on("request", (r) => {
  const u = new URL(r.url())
  if (u.pathname.startsWith("/api/")) out.apiLog.push(`${r.method()} ${u.pathname}`)
})

// 采样器在文档脚本执行前注入：每次导航/重载都可用，覆盖编辑器初始化全程。
await context.addInitScript(() => {
  window.__qaSample = (w) =>
    new Promise((resolve) => {
      const readLabel = () => {
        const el = document.querySelector('[aria-label="段落样式"]')
        if (!el) return null
        const sv = el.querySelector("[data-slot]")
        return (sv ?? el).textContent?.trim() ?? null
      }
      const t0 = performance.now()
      const samples = []
      const tick = () => {
        const label = readLabel()
        if (label !== null) samples.push({ t: Math.round(performance.now() - t0), label })
        if (performance.now() - t0 < w) requestAnimationFrame(tick)
        else
          resolve({
            samples,
            distinct: [...new Set(samples.map((s) => s.label))],
            firstAt: samples[0]?.t ?? null,
            lastAt: samples[samples.length - 1]?.t ?? null
          })
      }
      requestAnimationFrame(tick)
    })
})

try {
  // ── 登录态 ──
  if (cookieFile) {
    const host = new URL(baseUrl).hostname
    const cookies = readFileSync(OUT(cookieFile), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        let httpOnly = false
        if (l.startsWith("#HttpOnly_")) {
          httpOnly = true
          l = l.slice("#HttpOnly_".length)
        } else if (l.startsWith("#")) return null
        const p = l.split("\t")
        if (p.length < 7) return null
        return {
          name: p[5], value: p[6].trim(), domain: host, path: p[2] || "/",
          httpOnly, secure: p[3] === "TRUE", expires: Math.floor(Date.now() / 1000) + 3600
        }
      })
      .filter(Boolean)
    await context.addCookies(cookies)
  }
  const page = await context.newPage()
  const apiMe = await page.request.get(`${baseUrl}/api/me`)
  if (apiMe.ok()) {
    const body = await apiMe.text()
    check("会话自证 /api/me", body.includes("qa229"), `status=${apiMe.status()}`)
  }

  if (!apiMe.ok() && passwordFile) {
    const pass = readFileSync(OUT(passwordFile), "utf8").trim()
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" })
    await page.fill('input[name="email"]', "qa229@ciki-qa.test")
    await page.fill('input[name="password"]', pass)
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }),
      page.click('button[type="submit"]')
    ])
    check("UI 真实登录", true, `landed=${page.url()}`)
  }

  // ── 口径 1：多次重载编辑页，goto 后立即采样，覆盖初始化全程（零交互）──
  const reloadResults = []
  for (let i = 1; i <= RELOADS; i++) {
    await page.goto(EDIT_URL, { waitUntil: "domcontentloaded" })
    const s = await page.evaluate((w) => window.__qaSample(w), 4000)
    if (!s) {
      check(`重载采样#${i}`, false, "sample promise 未返回（注入失败？）")
      reloadResults.push({ run: i, distinct: ["<no-sample>"] })
      continue
    }
    const ok = s.distinct.length === 1 && s.distinct[0] === "正文"
    reloadResults.push({ run: i, distinct: s.distinct, n: s.samples.length, firstAt: s.firstAt, lastAt: s.lastAt })
    check(`重载采样#${i}`, ok, `distinct=${JSON.stringify(s.distinct)} samples=${s.samples.length} window=${s.firstAt}..${s.lastAt}ms`)
  }
  const allOk = reloadResults.every((r) => r.distinct.length === 1 && r.distinct[0] === "正文")
  check("口径1 初始标签稳定一致（全部重载）", allOk, `${RELOADS} 次 distinct=${JSON.stringify(reloadResults.map((r) => r.distinct))}`)
  out.reloadResults = reloadResults

  // ── 主题前置：切到 light ──
  await page.goto(EDIT_URL, { waitUntil: "domcontentloaded" })
  await page.waitForSelector('[aria-label="段落样式"]', { state: "visible", timeout: 30000 })
  const mode0 = await page.evaluate(() => document.documentElement.dataset.mode)
  const cycle = async (targetMode) => {
    for (let k = 0; k < 3; k++) {
      const m = await page.evaluate(() => document.documentElement.dataset.mode)
      if (m === targetMode) return m
      await page.click('button[aria-label^="主题："]')
      await page.waitForFunction((t) => document.documentElement.dataset.mode === t, targetMode, { timeout: 5000 }).catch(() => {})
    }
    return page.evaluate(() => document.documentElement.dataset.mode)
  }
  const modeLight = await cycle("light")
  check("主题 light 生效", modeLight === "light", `data-mode=${modeLight}（初始 ${mode0}）`)

  // light 主题下：初始标签复采样 + 口径 2 全跟随链
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector(`.ProseMirror :text("${MARK_H2}")`, { state: "visible", timeout: 30000 })
  await page.waitForSelector('[aria-label="段落样式"]', { state: "visible", timeout: 30000 })
  const sLight = await sampleLabel(page, { windowMs: 1500 })
  check("light 主题初始标签", sLight.distinct.join() === "正文", `distinct=${JSON.stringify(sLight.distinct)}`)
  await page.screenshot({ path: OUT(`shots/${originName}-light-edit-initial.png`) })

  // 前置守卫：确保首块是 h2（页面可能被上一轮跑动过）
  const hasH2 = await page.evaluate(() => !!document.querySelector(".ProseMirror h2"))
  if (!hasH2) {
    await page.click(`.ProseMirror p:has-text("${MARK_H2}")`)
    await page.waitForTimeout(150)
    await page.click('[aria-label="段落样式"]')
    await page.waitForSelector('[role="listbox"]', { state: "visible", timeout: 5000 })
    await page.click('[role="option"]:has-text("标题 2")')
    await page.waitForTimeout(200)
    check("前置：首块恢复为 h2", true, "via dropdown")
  }

  await page.click(`.ProseMirror p:has-text("${MARK_P}")`)
  await page.waitForTimeout(150)
  const l1 = await readLabel(page)
  check("口径2a 点进正文→正文", l1 === "正文", `label=${l1}`)

  await page.click(`.ProseMirror h2:has-text("${MARK_H2}")`)
  await page.waitForTimeout(150)
  const l2 = await readLabel(page)
  check("口径2b 点进标题2→标题 2", l2 === "标题 2", `label=${l2}`)
  await page.screenshot({ path: OUT(`shots/${originName}-light-follow-heading.png`) })

  await page.click('[aria-label="段落样式"]')
  await page.waitForSelector('[role="listbox"]', { state: "visible", timeout: 5000 })
  await page.click('[role="option"]:has-text("标题 3")')
  await page.waitForTimeout(200)
  const l3 = await readLabel(page)
  const hasH3 = await page.evaluate(() => !!document.querySelector(".ProseMirror h3"))
  check("口径2c 切标题3→标签跟随+文档h3", l3 === "标题 3" && hasH3, `label=${l3} h3=${hasH3}`)
  await page.screenshot({ path: OUT(`shots/${originName}-light-switch-h3.png`) })

  await page.click('[aria-label="段落样式"]')
  await page.waitForSelector('[role="listbox"]', { state: "visible", timeout: 5000 })
  await page.click('[role="option"]:has-text("正文")')
  await page.waitForTimeout(200)
  const l4 = await readLabel(page)
  const h3Gone = await page.evaluate(() => !document.querySelector(".ProseMirror h3"))
  check("口径2d 切回正文→标签跟随+h3还原", l4 === "正文" && h3Gone, `label=${l4} h3Gone=${h3Gone}`)

  // 恢复首块为标题：点首块（现在是段落）→ 下拉选「标题 2」（不依赖键盘撤销的焦点行为）
  await page.click(`.ProseMirror p:has-text("${MARK_H2}")`)
  await page.waitForTimeout(150)
  await page.click('[aria-label="段落样式"]')
  await page.waitForSelector('[role="listbox"]', { state: "visible", timeout: 5000 })
  await page.click('[role="option"]:has-text("标题 2")')
  await page.waitForTimeout(200)
  const afterRestore = await page.evaluate(() => ({
    h2: !!document.querySelector(".ProseMirror h2"),
    h3: !!document.querySelector(".ProseMirror h3")
  }))
  const labelRestored = await readLabel(page)
  check("下拉恢复首块为标题 2", afterRestore.h2 && !afterRestore.h3 && labelRestored === "标题 2", JSON.stringify(afterRestore) + ` label=${labelRestored}`)

  // ── 口径 3：⌘S 保存（留在编辑态）──
  await page.click(`.ProseMirror p:has-text("${MARK_P}")`)
  await page.keyboard.press("End")
  await page.keyboard.type("QA229-SAVE-R1")
  await page.waitForTimeout(200)
  await page.keyboard.press("Control+s")
  await page.waitForTimeout(1200)
  await page.screenshot({ path: OUT(`shots/${originName}-save-cmds.png`) })
  const resp = await page.request.get(`${baseUrl}/api/pages/${PAGE_ID}?format=json`)
  const pj = await resp.json()
  const saved = (pj.contentText || "").includes("QA229-SAVE-R1")
  check("口径3a ⌘S 保存内容落库", saved, `contentText 含 R1=${saved}`)

  const revResp = await page.request.get(`${baseUrl}/api/pages/${PAGE_ID}/revisions`)
  const revs = await revResp.json()
  const revCount = Array.isArray(revs) ? revs.length : (revs.revisions || []).length
  check("口径3b 保存生成版本", revCount >= 1, `revisions=${revCount}`)
  out.revisionCount = revCount

  // 保存按钮流程：再改一处 → 点「保存」→ 应回阅读页
  await page.click(`.ProseMirror p:has-text("${MARK_P}")`)
  await page.keyboard.press("End")
  await page.keyboard.type(" QA229-SAVE-R2")
  await page.waitForTimeout(200)
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes("/edit"), { timeout: 20000 }),
    page.click('button:has-text("保存")')
  ])
  check("口径3c 保存按钮回阅读页", !page.url().includes("/edit"), page.url())

  // 等 React 切换完成：编辑器卸载 → 阅读页内容渲染出 R2
  await page.waitForSelector(".ProseMirror", { state: "detached", timeout: 20000 })
  await page.waitForSelector(':text("QA229-SAVE-R2")', { state: "visible", timeout: 20000 })
  const readText = await page.evaluate(() => document.body.innerText)
  const hasR1 = readText.includes("QA229-SAVE-R1")
  const hasR2 = readText.includes("QA229-SAVE-R2")
  check("口径3d 阅读页呈现保存内容", hasR1 && hasR2, `R1=${hasR1} R2=${hasR2}`)
  if (!hasR1 || !hasR2) {
    const i = readText.indexOf("QA229")
    console.log("innerText snippet:", JSON.stringify(readText.slice(i, i + 300)))
  }
  await page.screenshot({ path: OUT(`shots/${originName}-read-after-save.png`) })

  // ── dark 主题：主路径一轮 ──
  const modeDark = await cycle("dark")
  check("主题 dark 生效", modeDark === "dark", `data-mode=${modeDark}`)
  await page.goto(EDIT_URL, { waitUntil: "domcontentloaded" })
  await page.waitForSelector(`.ProseMirror :text("${MARK_H2}")`, { state: "visible", timeout: 30000 })
  await page.waitForSelector('[aria-label="段落样式"]', { state: "visible", timeout: 30000 })
  const sDark = await sampleLabel(page, { windowMs: 1500 })
  check("dark 主题初始标签", sDark.distinct.join() === "正文", `distinct=${JSON.stringify(sDark.distinct)}`)
  await page.screenshot({ path: OUT(`shots/${originName}-dark-edit-initial.png`) })
  await page.click(`.ProseMirror h2:has-text("${MARK_H2}")`)
  await page.waitForTimeout(150)
  const l5 = await readLabel(page)
  check("dark 主题点进标题→标题 2", l5 === "标题 2", `label=${l5}`)
  await page.screenshot({ path: OUT(`shots/${originName}-dark-follow-heading.png`) })
  out.darkBodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err)
  console.log("FATAL:", out.fatal)
} finally {
  writeFileSync(OUT(`results-${originName}.json`), JSON.stringify(out, null, 2))
  await browser.close().catch(() => {})
}
const fails = out.checks.filter((c) => !c.ok).length
console.log(`\n== ${originName} 汇总: ${out.checks.length - fails}/${out.checks.length} PASS, ${fails} FAIL ==`)
process.exit(0)
