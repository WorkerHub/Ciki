/** 调试：为什么点「代码块」按钮没有插入代码块 */
import fs from "node:fs"
import { chromium } from "playwright-core"

const EXEC =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const state = JSON.parse(fs.readFileSync("/tmp/qa244-state.json", "utf8"))
const BASE = state.base
const HOST = new URL(BASE).host

const browser = await chromium.launch({
  headless: true,
  executablePath: EXEC,
  proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" },
})
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } })
await context.addCookies([
  { name: "ciki_session", value: state.sessionToken, domain: HOST, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
])
const page = await context.newPage()
page.on("console", (m) => console.log("[console]", m.type(), m.text()))
await page.goto(`${BASE}/p/${state.pageId}/edit`, { waitUntil: "domcontentloaded" })
await page.locator('[role="toolbar"]').waitFor({ state: "visible", timeout: 45000 })
await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 45000 })
await page.waitForTimeout(800)

console.log("初始 pre 数量:", await page.locator(".ProseMirror pre").count())
console.log("初始正文:", await page.locator(".ProseMirror").innerHTML())

const codeBtn = page.getByRole("button", { name: "代码块" })
console.log("代码块按钮 count:", await codeBtn.count(), "disabled:", await codeBtn.first().isDisabled())
console.log("按钮 aria-pressed:", await codeBtn.first().getAttribute("aria-pressed"))
console.log("按钮 bbox:", JSON.stringify(await codeBtn.first().boundingBox()))

// 方案 A：直接点正文，再点按钮
await page.locator(".ProseMirror p").first().click()
await page.waitForTimeout(300)
const sel = await page.evaluate(() => {
  const s = window.getSelection()
  return { anchorText: s?.anchorNode?.textContent?.slice(0, 40), isInPM: !!s?.anchorNode?.parentElement?.closest(".ProseMirror") }
})
console.log("点击正文后 selection:", JSON.stringify(sel))
await codeBtn.first().click()
await page.waitForTimeout(800)
console.log("方案A 之后 pre 数量:", await page.locator(".ProseMirror pre").count())
console.log("方案A 之后 data-code-block:", await page.locator("[data-code-block]").count())
console.log("方案A 之后 aria-pressed:", await codeBtn.first().getAttribute("aria-pressed"))
console.log("方案A 之后正文:", (await page.locator(".ProseMirror").innerHTML()).slice(0, 600))

await browser.close()
