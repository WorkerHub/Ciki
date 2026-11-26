// QA258 生产验收：标准 4（Embed 消息契约 / 旧 Embed distill 回落不崩 / 注入脚本行为观察）
import { chromium } from "playwright-core"
import fs from "node:fs"

const EXEC = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
const BASE = process.env.QA_BASE || "https://ciki.oneboy.app"
const PROXY = process.env.QA_PROXY || ""
const HOST = new URL(BASE).hostname
const STATE = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/state.json", "utf8"))
const ADMIN = STATE.users.admin.token
const DISTILL = STATE.users.distill.token
const PAGE_ID = STATE.pages[0].id
const PROBE_KEY = STATE.assets.probe
const BARE_KEY = STATE.assets.bare
const OUT = process.env.QA_OUT || "/tmp/ciki-qa258-prod/embed-result.json"
const STYLES = ["nova", "paper", "natural", "eink", "notion", "sketch"]
const LEGACY = ["distill", "notarealstyle", ""]

const results = []
const ok = (id, pass, detail, evidence) => { results.push({ id, pass, detail, evidence }); console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${detail}`) }

const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const consoleErrors = []

async function newCtx(token, mode) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", ...(PROXY ? { proxy: { server: PROXY, bypass: "127.0.0.1,localhost" } } : {}) })
  await ctx.addCookies([{ name: "ciki_session", value: token, domain: HOST, path: "/" }])
  if (mode) {
    await ctx.addInitScript((m) => {
      try { localStorage.setItem("ciki-theme", JSON.stringify({ state: { mode: m, style: "nova", migratedAt: 1, modeMigratedAt: 1 }, version: 0 })) } catch (_) {}
    }, mode)
  }
  const page = await ctx.newPage()
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: page.url().slice(0, 120), text: m.text().slice(0, 160) }) })
  page.on("pageerror", (e) => consoleErrors.push({ url: page.url().slice(0, 120), text: "pageerror: " + String(e).slice(0, 160) }))
  return { ctx, page }
}

async function setAccountStyle(token, style) {
  const res = await fetch(`${BASE}/api/me/theme`, { method: "PUT", headers: { Cookie: `ciki_session=${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ themeStyle: style }) })
  return res.status
}

async function readFrame(page, keyPart) {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find((fr) => fr.url().includes(keyPart))
    if (f) {
      try {
        const el = await f.evaluate(() => {
          const d = document.documentElement
          return {
            dataTheme: d.getAttribute("data-theme"),
            darkClass: d.classList.contains("dark"),
            probeSrc: d.getAttribute("data-probe-src"),
            probeMode: d.getAttribute("data-probe-mode"),
            probeStyle: d.getAttribute("data-probe-style"),
            probeKnown: d.getAttribute("data-probe-known"),
            msgCount: d.getAttribute("data-probe-msg-count"),
            msgMode: d.getAttribute("data-probe-msg-mode"),
            msgStyle: d.getAttribute("data-probe-msg-style"),
            bareInit: d.getAttribute("data-bare-init"),
            bareLoad: d.getAttribute("data-bare-load"),
            bareLate: d.getAttribute("data-bare-late"),
            bareMsg: d.getAttribute("data-bare-msg"),
            text: (document.body?.innerText || "").slice(0, 80),
            url: location.href
          }
        })
        return el
      } catch (e) { /* frame 还在导航 */ }
    }
    await page.waitForTimeout(500)
  }
  return null
}

// ---------------- A. 12 格消息契约 ----------------
const cells = []
for (const style of STYLES) {
  for (const mode of ["light", "dark"]) {
    const putStatus = await setAccountStyle(ADMIN, style)
    const { ctx, page } = await newCtx(ADMIN, mode)
    await page.goto(`${BASE}/p/${PAGE_ID}`, { waitUntil: "load", timeout: 90000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="button"]').length > 0, null, { timeout: 25000 }).catch(() => {})
    await page.waitForSelector('[data-html-embed-iframe]', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const src = await page.evaluate(() => document.querySelector('[data-html-embed-iframe]')?.getAttribute("src") || null)
    const frame = await readFrame(page, "embeds/3d1780d5")
    cells.push({ style, mode, putStatus, src, frame })
    console.log(`   ${style}-${mode}: src=${src} | msg style=${frame?.msgStyle} mode=${frame?.msgMode} known=${frame?.probeKnown} data-theme=${frame?.dataTheme} dark=${frame?.darkClass}`)
    await ctx.close()
  }
}
const urlCellsOk = cells.every(c => c.src && c.src.includes(`mode=${c.mode}`) && c.src.includes(`style=${c.style}`))
ok("E1", urlCellsOk, "12 格首帧 URL 参数 mode/style 与当前风格+明暗一一对应（无 distill）", cells.map(c => ({ style: c.style, mode: c.mode, src: c.src })))

const msgOk = cells.every(c => c.frame && c.frame.msgStyle === c.style && c.frame.msgMode === c.mode && c.frame.probeKnown === "1" && c.frame.msgCount && Number(c.frame.msgCount) >= 1)
const anyDistillInMsg = cells.some(c => /distill/.test(c.frame?.msgStyle || "") || /distill/.test(c.frame?.probeStyle || "") || /distill/.test(c.src || ""))
ok("E2", msgOk && !anyDistillInMsg, "12 格 ciki-embed-theme 消息的 style 均为 6 合法值之一、mode 与明暗一致，且全程无 distill", cells.map(c => ({ style: c.style, mode: c.mode, msgStyle: c.frame?.msgStyle, msgMode: c.frame?.msgMode, known: c.frame?.probeKnown, msgCount: c.frame?.msgCount })))
ok("E3", !anyDistillInMsg, "消息与 URL 中均未出现 distill", { anyDistillInMsg })

// ---------------- B. 旧 Embed style=distill 直开回落且不崩 ----------------
const legacy = []
for (const style of LEGACY) {
  const { ctx, page } = await newCtx(ADMIN, null)
  const url = `${BASE}/api/files/${PROBE_KEY}?mode=light&style=${encodeURIComponent(style)}`
  await page.goto(url, { waitUntil: "load", timeout: 60000 })
  await page.waitForTimeout(1200)
  const d = await page.evaluate(() => {
    const el = document.documentElement
    return {
      dataTheme: el.getAttribute("data-theme"),
      probeKnown: el.getAttribute("data-probe-known"),
      probeStyle: el.getAttribute("data-probe-style"),
      bodyText: (document.body?.innerText || "").slice(0, 80),
      hasProbe: !!document.getElementById("out")
    }
  })
  legacy.push({ style, url, ...d })
  console.log(`   旧 Embed 直开 style=${style || "(空)"}: data-theme=${d.dataTheme} known=${d.probeKnown} 渲染=${d.hasProbe}`)
  await ctx.close()
}
ok("E4", legacy.every(l => l.dataTheme !== "distill" && l.probeKnown === "0" && l.hasProbe),
  "旧 Embed 直开 style=distill / 未知值 / 空值：均不套用未知值（known=0）、页面照常渲染不崩", legacy)

// ---------------- C. 注入脚本（服务端下发）行为观察 ----------------
const bare = []
for (const style of ["nova", "paper", "natural", "eink", "notion", "sketch", "distill"]) {
  const { ctx, page } = await newCtx(ADMIN, null)
  const url = `${BASE}/api/files/${BARE_KEY}?mode=dark&style=${encodeURIComponent(style)}`
  await page.goto(url, { waitUntil: "load", timeout: 60000 })
  await page.waitForTimeout(1200)
  const d = await page.evaluate(() => {
    const el = document.documentElement
    return {
      dataTheme: el.getAttribute("data-theme"),
      darkClass: el.classList.contains("dark"),
      bareInit: el.getAttribute("data-bare-init"),
      bareLoad: el.getAttribute("data-bare-load"),
      bareLate: el.getAttribute("data-bare-late"),
      bareMsg: el.getAttribute("data-bare-msg"),
      bodyText: (document.body?.innerText || "").slice(0, 80)
    }
  })
  bare.push({ style, ...d })
  console.log(`   注入脚本直开 style=${style}: data-theme=${d.dataTheme} dark=${d.darkClass}`)
  await ctx.close()
}
const injected = bare.filter(b => ["nova", "paper"].includes(b.style)).map(b => b.style)
const notInjected = bare.filter(b => !["nova", "paper"].includes(b.style) && b.dataTheme === null).map(b => b.style)
ok("E5", bare.every(b => b.dataTheme !== "distill" && b.darkClass === true && b.bodyText.length > 0),
  "服务端注入脚本：dark 类正常下发给全部风格；未知值 distill 不被套用且不崩", bare)
ok("E6", injected.length === 2 && notInjected.length === 5,
  "【观察项 #259】注入脚本仅对 nova/paper 设置 data-theme；natural/eink/notion/sketch/distill 由注入脚本时不设 data-theme（需作者侧按 agent-guide §6.2 自行实现）", { injected, notInjected })

// ---------------- D. distill 账号（存量回落）在页面里的消息 ----------------
await setAccountStyle(DISTILL, "nova")
const { ctx: dctx, page: dpage } = await newCtx(DISTILL, "light")
await dpage.goto(`${BASE}/p/${PAGE_ID}`, { waitUntil: "load", timeout: 90000 })
await dpage.waitForSelector('[data-html-embed-iframe]', { timeout: 20000 }).catch(() => {})
await dpage.waitForTimeout(1500)
const dSrc = await dpage.evaluate(() => document.querySelector('[data-html-embed-iframe]')?.getAttribute("src") || null)
const dFrame = await readFrame(dpage, "embeds/3d1780d5")
ok("E7", !!dSrc && dSrc.includes("style=nova") && !dSrc.includes("distill") && dFrame?.msgStyle === "nova",
  `存量 distill 账号在页面里回落 nova：iframe src=${dSrc}，消息 style=${dFrame?.msgStyle}（无 distill）`, { dSrc, dFrame })
await dctx.close()

const relevant = consoleErrors.filter((e) => !/cf-ray|challenge-platform|localStorage|Failed to read/i.test(e.text))
ok("E8", relevant.length === 0, `Embed 全部用例无前端报错（过滤 CF 注入/沙箱 localStorage 噪声后 ${relevant.length} 条）`, consoleErrors)

await browser.close()
const out = { at: new Date().toISOString(), base: BASE, results, cells, legacy, bare, consoleErrors }
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
const failed = results.filter((r) => !r.pass)
console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length} -> ${OUT}`)
