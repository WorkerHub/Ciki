import { launch, newContext, writeJson, SHOTS } from "./lib.mjs"
import fs from "node:fs"

/** 参考站截图：byte-sized-algorithms（纸面观感参照物） */
const REF = "https://byte-sized-algorithms.vercel.app/"

const browser = await launch()
const dir = `${SHOTS}/reference`
fs.mkdirSync(dir, { recursive: true })

const out = {}
for (const scheme of ["light", "dark"]) {
  const context = await newContext(browser, { width: 1440, height: 900 })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: scheme })
  await page.goto(REF, { waitUntil: "networkidle", timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${dir}/${scheme}-viewport.png` })
  await page.screenshot({ path: `${dir}/${scheme}-full.png`, fullPage: true })
  out[scheme] = await page.evaluate(() => {
    const body = getComputedStyle(document.body)
    const p = document.querySelector("p")
    const pre = document.querySelector("pre")
    const code = pre ? pre.querySelector("code") : null
    const h1 = document.querySelector("h1")
    const bg = body.backgroundColor
    const fg = body.color
    const px = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || "")
      if (!m) return null
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] }
    }
    const lum = (c) => {
      const p2 = px(c)
      if (!p2) return null
      const f = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(p2.r) + 0.7152 * f(p2.g) + 0.0722 * f(p2.b)
    }
    const contrast = (a, b) => {
      const l1 = lum(a)
      const l2 = lum(b)
      if (l1 == null || l2 == null) return null
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    return {
      title: document.title,
      bg,
      fg,
      contrast: contrast(fg, bg),
      bodyFontFamily: body.fontFamily,
      bodyFontSize: body.fontSize,
      h1FontFamily: h1 ? getComputedStyle(h1).fontFamily : null,
      h1Size: h1 ? getComputedStyle(h1).fontSize : null,
      h1Weight: h1 ? getComputedStyle(h1).fontWeight : null,
      pFontFamily: p ? getComputedStyle(p).fontFamily : null,
      pFontSize: p ? getComputedStyle(p).fontSize : null,
      pLineHeight: p ? getComputedStyle(p).lineHeight : null,
      preBg: pre ? getComputedStyle(pre).backgroundColor : null,
      preFg: code ? getComputedStyle(code).color : null,
      preFontFamily: pre ? getComputedStyle(pre).fontFamily : null,
      preBorder: pre ? getComputedStyle(pre).borderTopColor : null,
      pageHeight: document.body.scrollHeight
    }
  })
  await context.close()
}
writeJson("/tmp/qa/reference-metrics.json", out)
console.log(JSON.stringify(out, null, 2))
await browser.close()
