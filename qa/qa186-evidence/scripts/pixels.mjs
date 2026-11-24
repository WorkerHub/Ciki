import fs from "node:fs"
import { launch, newContext, attachSession, installTheme, goto, writeJson, SHOTS } from "./lib.mjs"

/**
 * 纸纹理与「实际渲染对比度」度量：
 *  - flat：纯背景区域 → 均值 / 亮度标准差（纹理扰动强度）
 *  - text：正文行区域 → 渲染像素的最暗/最亮（实际对比度）
 * 同时把 oklch 等任意颜色归一化为 rgb 以便算对比度。
 */
const BASE = "http://127.0.0.1:9311"
const COOKIE = "/tmp/qa/cookies-new.json"
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]

const RECTS = {
  // 视口 1440x900：正文列 x=284 起，paper 模式内容宽 860（到 x=1144）
  flat: { x: 1200, y: 620, w: 200, h: 120 },
  text: { x: 284, y: 238, w: 620, h: 30 },
  codeText: { x: 300, y: 330, w: 620, h: 26 }
}

const browser = await launch()
const report = {}

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const context = await newContext(browser, { width: 1440, height: 900 })
  await attachSession(context, COOKIE)
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  await goto(page, BASE, "/p/1", "h1")
  await page.waitForTimeout(700)
  const buf = await page.screenshot()
  fs.writeFileSync(`${SHOTS}/px-${key}.png`, buf)
  await context.close()

  const stats = await page.evaluate
    ? null
    : null
  const res = await analyze(browser, buf)
  report[key] = { rects: RECTS, ...res }
  console.log(
    key,
    "flat mean/std:",
    JSON.stringify(res.flat),
    "text contrast:",
    JSON.stringify(res.text)
  )
}

async function analyze(browser, buf) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const out = await page.evaluate(
    async ([b64, rects]) => {
      const img = new Image()
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
        img.src = "data:image/png;base64," + b64
      })
      const c = document.createElement("canvas")
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext("2d")
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, img.width, img.height).data
      const lum = (r, g, b) => {
        const f = (v) => {
          v /= 255
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const cr = (l1, l2) => {
        const hi = Math.max(l1, l2)
        const lo = Math.min(l1, l2)
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
      }
      const stat = (r) => {
        let n = 0,
          sr = 0,
          sg = 0,
          sb = 0
        const lums = []
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const i = (y * img.width + x) * 4
            sr += d[i]
            sg += d[i + 1]
            sb += d[i + 2]
            lums.push(lum(d[i], d[i + 1], d[i + 2]))
            n++
          }
        }
        const mean = [sr / n, sg / n, sb / n].map((v) => Math.round(v * 100) / 100)
        const m = lums.reduce((a, b) => a + b, 0) / n
        const sd = Math.sqrt(lums.reduce((a, b) => a + (b - m) ** 2, 0) / n)
        const sorted = [...lums].sort((a, b) => a - b)
        const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
        const min = sorted[0]
        const max = sorted[sorted.length - 1]
        // 文本区域：取 5% 分位当文字色，95% 分位当背景色
        const textL = pct(0.05)
        const bgL = pct(0.95)
        return {
          mean,
          sd: Math.round(sd * 10000) / 10000,
          p05: Math.round(textL * 1000) / 1000,
          p95: Math.round(bgL * 1000) / 1000,
          minContrast: cr(min, max),
          p05p95Contrast: cr(textL, bgL),
          minLum: Math.round(min * 1000) / 1000,
          maxLum: Math.round(max * 1000) / 1000
        }
      }
      return { flat: stat(rects.flat), text: stat(rects.text), codeText: stat(rects.codeText) }
    },
    [buf.toString("base64"), RECTS]
  )
  await context.close()
  return out
}

writeJson("/tmp/qa/pixels.json", report)
await browser.close()
console.log("done")
