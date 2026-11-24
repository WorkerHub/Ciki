/**
 * QA #182 探针：页面 1 表格在 ReadView 里的真实渲染（th 内容/table-layout/量测）。
 * 用法: node qa182-table-probe.mjs <port> <tag>
 */
import { chromium } from "playwright"

const port = process.argv[2] ?? "8907"
const BASE = `http://127.0.0.1:${port}`

const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "jim@example.com", password: "JimPass123!" })
})
const m = /ciki_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies([{ name: "ciki_session", value: m[1], domain: "127.0.0.1", path: "/" }])
const page = await ctx.newPage()
await page.goto(`${BASE}/p/1`, { waitUntil: "domcontentloaded" })
await page.locator("h1", { hasText: "聚焦环验收页" }).waitFor({ timeout: 20000 })
await page.waitForTimeout(800)

const info = await page.evaluate(() => {
  const wrap = document.querySelector(".wiki-content .tableWrapper")
  const table = document.querySelector(".wiki-content table")
  const ths = table ? Array.from(table.querySelectorAll("th")).map((t) => t.textContent.trim().slice(0, 40)) : []
  const cs = table ? getComputedStyle(table) : null
  return {
    hasWrapper: !!wrap,
    tableScrollW: table?.scrollWidth,
    tableClientW: table?.clientWidth,
    wrapScrollW: wrap?.scrollWidth,
    wrapClientW: wrap?.clientWidth,
    wrapRectW: wrap?.getBoundingClientRect().width,
    tableLayout: cs?.tableLayout,
    tableWidthCss: cs?.width,
    thCount: ths.length,
    ths,
    firstThRectW: table?.querySelector("th")?.getBoundingClientRect().width,
    tableRectW: table?.getBoundingClientRect().width
  }
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
