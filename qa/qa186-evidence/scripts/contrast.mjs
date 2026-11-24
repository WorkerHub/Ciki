import fs from "node:fs"
import { launch, newContext, attachSession, installTheme } from "./lib.mjs"

/**
 * 统一口径的对比度测量：把任意 CSS 颜色（oklch / rgb / 透明叠加）用 canvas fillStyle 归一到 sRGB，
 * 再算 WCAG 对比度。四格同法测，便于 nova 与 paper 横向比。
 */
const BASE = "http://127.0.0.1:9311"
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]
const browser = await launch()
const report = {}

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const context = await newContext(browser, { width: 1440, height: 900 })
  await installTheme(context, combo.style, combo.mode)
  await attachSession(context, "/tmp/qa/cookies-new.json")
  const page = await context.newPage()
  await page.goto(`${BASE}/p/1`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("h1", { timeout: 20000 })
  await page.waitForTimeout(1500)
  const data = await page.evaluate(() => {
    const cvs = document.createElement("canvas")
    cvs.width = cvs.height = 1
    const ctx = cvs.getContext("2d", { willReadFrequently: true })
    const toRgb = (css) => {
      // alpha 混合到白/黑不适用；这里只取不透明色
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#000000"
      ctx.fillStyle = css
      const s = ctx.fillStyle
      if (s.startsWith("#")) {
        const h = s.slice(1)
        const v = h.length === 3 ? h.split("").map((x) => x + x).join("") : h
        return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
      }
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s)
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
    }
    const lum = (rgb) => {
      if (!rgb) return null
      const f = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
    }
    const contrast = (fgCss, bgCss) => {
      const l1 = lum(toRgb(fgCss))
      const l2 = lum(toRgb(bgCss))
      if (l1 === null || l2 === null) return null
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    const g = (sel, prop = "color") => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el)[prop] : null
    }
    const bgOf = (el) => {
      let n = el
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c
        n = n.parentElement
      }
      return getComputedStyle(document.body).backgroundColor
    }
    const para = document.querySelector(".wiki-content p") || document.querySelector("p")
    const pre = document.querySelector(".wiki-content pre")
    const th = document.querySelector(".wiki-content th")
    const td = document.querySelector(".wiki-content td")
    const quote = document.querySelector(".wiki-content blockquote")
    const inlineCode = document.querySelector(".wiki-content p code")
    const out = {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      items: {}
    }
    out.items.para = {
      fg: getComputedStyle(para).color,
      bg: bgOf(para),
      contrast: contrast(getComputedStyle(para).color, bgOf(para)),
      fontFamily: getComputedStyle(para).fontFamily
    }
    if (pre) {
      const cs = getComputedStyle(pre)
      out.items.code = {
        fg: cs.color,
        bg: cs.backgroundColor,
        contrast: contrast(cs.color, cs.backgroundColor),
        fontFamily: cs.fontFamily
      }
    }
    if (th)
      out.items.tableHeader = {
        fg: getComputedStyle(th).color,
        bg: getComputedStyle(th).backgroundColor,
        contrast: contrast(getComputedStyle(th).color, getComputedStyle(th).backgroundColor)
      }
    if (td)
      out.items.tableCell = {
        fg: getComputedStyle(td).color,
        bg: bgOf(td),
        contrast: contrast(getComputedStyle(td).color, bgOf(td))
      }
    if (quote) {
      const cs = getComputedStyle(quote)
      out.items.quote = {
        fg: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderLeftColor,
        contrast: contrast(cs.color, cs.backgroundColor || bgOf(quote))
      }
    }
    if (inlineCode) {
      const cs = getComputedStyle(inlineCode)
      out.items.inlineCode = {
        fg: cs.color,
        bg: cs.backgroundColor,
        contrast: contrast(cs.color, cs.backgroundColor),
        fontFamily: cs.fontFamily
      }
    }
    return out
  })
  report[key] = data
  console.log(key, JSON.stringify(data.items, null, 1))
  await context.close()
}
fs.writeFileSync("/tmp/qa/contrast.json", JSON.stringify(report, null, 2))
await browser.close()
