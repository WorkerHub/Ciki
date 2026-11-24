import fs from "node:fs"
import { launch, newContext, installTheme, goto, writeJson, SHOTS } from "./lib.mjs"

/** 生产站（已部署 c7ddc22，含纸面主题）实测：纸面浅/暗是否真实生效 + 部署产物里是否带纸面令牌 */
const PROD = "https://ciki.pama.workers.dev"
const COMBOS = [
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" },
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" }
]

const browser = await launch()
const report = { prod: PROD, combos: {} }

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const context = await newContext(browser, { width: 1440, height: 900 })
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  await goto(page, PROD, "/login", "body")
  await page.waitForTimeout(1200)
  const info = await page.evaluate(() => {
    const root = document.documentElement
    const cs = (n) => getComputedStyle(root).getPropertyValue(n).trim()
    return {
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      darkClass: root.classList.contains("dark"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      bodyFont: getComputedStyle(document.body).fontFamily,
      fontSans: cs("--font-sans-family"),
      fontMono: cs("--font-mono-family"),
      background: cs("--background"),
      foreground: cs("--foreground"),
      card: cs("--card"),
      primary: cs("--primary"),
      border: cs("--border"),
      radius: cs("--radius"),
      appVersion: document.querySelector("meta[name='app-version']")?.content || null
    }
  })
  await page.screenshot({ path: `${SHOTS}/prod-paper-${key}.png` })
  report.combos[key] = info
  console.log(key, JSON.stringify(info))
  await context.close()
}

// 部署产物是否含纸面主题令牌
const ctx = await browser.newContext()
const p2 = await ctx.newPage()
await p2.goto(`${PROD}/login`, { waitUntil: "domcontentloaded" })
const assets = await p2.evaluate(() =>
  [...document.querySelectorAll("link[rel=stylesheet], script[src]")].map((e) =>
    e.tagName === "LINK" ? e.getAttribute("href") : e.getAttribute("src")
  )
)
report.assets = assets
let cssHit = null
for (const href of assets.filter((a) => a && a.endsWith(".css"))) {
  const res = await ctx.request.get(new URL(href, PROD).toString())
  const text = await res.text()
  if (text.includes("#f7f4ee") && text.includes("#0b0c0e")) {
    cssHit = {
      href,
      bytes: text.length,
      hasPaperLight: text.includes("#f7f4ee"),
      hasPaperDark: text.includes("#0b0c0e"),
      hasPaperFontStack: text.includes("Inter Variable") && text.includes("PingFang SC"),
      hasTextureRule: /body::after/.test(text),
      hasNovaGeist: text.includes("Geist Variable")
    }
  }
}
report.deployedCss = cssHit
console.log("deployedCss:", JSON.stringify(cssHit))
await ctx.close()
writeJson("/tmp/qa/prod-paper.json", report)
await browser.close()
console.log("done")
