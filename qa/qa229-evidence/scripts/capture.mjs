// QA #229 取证：连续 N 次重载编辑页，零交互高频采样；
// 命中「标题 2」时立即抓现场（截图 + activeElement + 采样时序），全样本落盘。
// 用法：node capture.mjs <base-url> <origin-name> <reloads>
import { chromium } from "playwright-core"
import { writeFileSync } from "node:fs"
import { launchOptions } from "./lib.mjs"

const [, , baseUrl, originName, reloadsArg] = process.argv
const PAGE_ID = Number(process.env.QA_PAGE_ID || 1)
const RELOADS = Number(reloadsArg || 20)
const EDIT_URL = `${baseUrl}/p/${PAGE_ID}/edit`
const OUT = (f) => `/tmp/ciki-qa229/${f}`

const browser = await chromium.launch(launchOptions())
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  reducedMotion: "reduce"
})
await context.addInitScript(() => {
  window.__qaSample = (w) =>
    new Promise((resolve) => {
      const readLabel = () => {
        const el = document.querySelector('[aria-label="段落样式"]')
        if (!el) return null
        const sv = el.querySelector("[data-slot]")
        return (sv ?? el).textContent?.trim() ?? null
      }
      const describeActive = () => {
        const a = document.activeElement
        if (!a) return "none"
        return `${a.tagName.toLowerCase()}${a.classList.contains("ProseMirror") ? ".ProseMirror" : ""}${a.getAttribute("aria-label") ? `[aria-label=${a.getAttribute("aria-label")}]` : ""}`
      }
      const hasH2 = () => !!document.querySelector(".ProseMirror h2")
      const t0 = performance.now()
      const samples = []
      const tick = () => {
        const label = readLabel()
        if (label !== null)
          samples.push({
            t: Math.round(performance.now() - t0),
            label,
            active: describeActive(),
            h2: hasH2()
          })
        if (performance.now() - t0 < w) requestAnimationFrame(tick)
        else {
          const distinct = [...new Set(samples.map((s) => s.label))]
          resolve({
            samples,
            distinct,
            firstAt: samples[0]?.t ?? null,
            firstHeadingAt: samples.find((s) => s.label !== "正文")?.t ?? null
          })
        }
      }
      requestAnimationFrame(tick)
    })
})

const page = await context.newPage()
// 登录态：先在 build 源登一次（本地 worker），cookie 注入
const pass = (await import("node:fs")).readFileSync("/tmp/ciki-qa229/qa229.pass", "utf8").trim()
await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" })
await page.fill('input[name="email"]', "qa229@ciki-qa.test")
await page.fill('input[name="password"]', pass)
await Promise.all([
  page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }),
  page.click('button[type="submit"]')
])

const all = []
let hits = 0
for (let i = 1; i <= RELOADS; i++) {
  await page.goto(EDIT_URL, { waitUntil: "domcontentloaded" })
  const s = await page.evaluate((w) => window.__qaSample(w), 3500)
  const hit = s.distinct.some((d) => d !== "正文")
  if (hit) {
    hits++
    await page.screenshot({ path: OUT(`shots/capture-${originName}-hit${hits}-run${i}.png`) })
  }
  all.push({ run: i, hit, distinct: s.distinct, firstAt: s.firstAt, firstHeadingAt: s.firstHeadingAt, n: s.samples.length, samples: s.samples })
  console.log(`#${i} ${hit ? "HIT" : "ok "} distinct=${JSON.stringify(s.distinct)} firstHeadingAt=${s.firstHeadingAt}`)
  writeFileSync(OUT(`capture-${originName}.json`), JSON.stringify(all, null, 1))
}
console.log(`\n== ${originName}: ${hits}/${RELOADS} 次命中非「正文」初始标签 ==`)
await browser.close()
process.exit(0)
