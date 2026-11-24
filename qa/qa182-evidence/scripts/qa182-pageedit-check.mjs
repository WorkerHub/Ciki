/**
 * QA #182 spot-check：PageEdit（/p/1/edit）横向溢出 —— 带宽表格页面进编辑器，
 * 页面级不得横向溢出，表格在编辑器内自己的容器滚动。双实例同跑。
 * 用法: node qa182-pageedit-check.mjs <port> <tag>
 */
import { chromium } from "playwright"
import fs from "node:fs"

const port = process.argv[2] ?? "8907"
const tag = process.argv[3] ?? "base"
const BASE = `http://127.0.0.1:${port}`
const OUT = `/tmp/qa182/evidence-${tag}`
fs.mkdirSync(OUT, { recursive: true })

const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "jim@example.com", password: "JimPass123!" })
})
if (!res.ok) throw new Error(`login failed: ${res.status}`)
const m = /ciki_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")

const VIEWPORTS = [
  { key: "m390", width: 390, height: 844, mobile: true },
  { key: "desk", width: 1440, height: 900, mobile: false }
]
const out = {}
const browser = await chromium.launch()
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      ...(vp.mobile ? { isMobile: true, hasTouch: true } : {}),
      storageState: { cookies: [{ name: "ciki_session", value: m[1], domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 * 7, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }
    })
    const page = await ctx.newPage()
    const errors = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()) })
    await page.goto(`${BASE}/p/1/edit`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector(".wiki-content, [contenteditable]", { timeout: 20000 })
    await page.waitForTimeout(1200)
    const info = await page.evaluate(() => {
      const doc = document.documentElement
      const tableWrap = document.querySelector(".wiki-content .tableWrapper")
      const editorScroll = (() => {
        let el = document.querySelector(".wiki-content")
        while (el) {
          const oy = getComputedStyle(el).overflowY
          if (oy === "auto" || oy === "scroll") {
            return { scrollW: el.scrollWidth, clientW: el.clientWidth, noH: el.scrollWidth <= el.clientWidth }
          }
          el = el.parentElement
        }
        return null
      })()
      return {
        docScrollWidth: doc.scrollWidth,
        innerWidth: window.innerWidth,
        pageNoH: doc.scrollWidth <= window.innerWidth,
        editorScroll,
        tableWrap: tableWrap
          ? { scrollW: tableWrap.scrollWidth, clientW: tableWrap.clientWidth, overflows: tableWrap.scrollWidth > tableWrap.clientWidth, overflowX: getComputedStyle(tableWrap).overflowX }
          : null,
        hasEditor: !!document.querySelector("[contenteditable]")
      }
    })
    await page.screenshot({ path: `${OUT}/pageedit-${vp.key}.png`, fullPage: false })
    out[vp.key] = { ...info, consoleErrors: errors }
    await ctx.close()
  }
} finally {
  await browser.close()
}
fs.writeFileSync(`${OUT}/pageedit-check.json`, JSON.stringify({ tag, port, ...out }, null, 2))
for (const [k, v] of Object.entries(out)) {
  console.log(`[${k}] pageNoH=${v.pageNoH} doc=${v.docScrollWidth}/${v.innerWidth} editorScroll=${JSON.stringify(v.editorScroll)} tableWrap=${JSON.stringify(v.tableWrap)} errors=${v.consoleErrors.length}`)
}
