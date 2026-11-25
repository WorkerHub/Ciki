import { chromium } from "playwright"
import fs from "node:fs"
const BASE = "http://localhost:9210"
const storageState = JSON.parse(fs.readFileSync("/tmp/qa-200/storage-state.json", "utf8"))
const browser = await chromium.launch()
const out = process.argv[2]
const results = []
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    storageState,
    reducedMotion: "reduce"
  })
  const page = await ctx.newPage()
  await page.addInitScript({
    content: `try{localStorage.setItem("ciki-theme", JSON.stringify({state:{theme:"paper",style:"light"},version:0}))}catch(e){}`,
    runBefore: "documentStart"
  })
  let url = "", pm = -1, bar = -1, label = "(no-bar)"
  try {
    await page.goto(`${BASE}/p/1/edit`, { waitUntil: "load", timeout: 30000 })
    url = page.url()
    await page.waitForSelector(".ProseMirror p", { timeout: 30000 })
    await page.waitForTimeout(2000)
    pm = await page.locator(".ProseMirror").count()
    bar = await page.locator("[data-editor-sticky-bar]").count()
    label = await page.evaluate(() => {
      const bar = document.querySelector("[data-editor-sticky-bar]")
      const buttons = bar ? [...bar.querySelectorAll("button")] : []
      const b2 = buttons[0]
      return b2 ? (b2.textContent || "").trim() : "(no-button)"
    })
  } catch (e) {
    label = "ERR: " + String(e).slice(0, 120)
  }
  results.push({ i, url, pm, bar, label })
  await ctx.close()
}
await browser.close()
console.log(out, JSON.stringify(results, null, 1))
