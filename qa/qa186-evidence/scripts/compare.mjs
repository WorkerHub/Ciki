import fs from "node:fs"
import {
  launch,
  newContext,
  attachSession,
  installTheme,
  goto,
  writeJson,
  SHOTS
} from "./lib.mjs"

/**
 * 像素级对照：
 *  A) 新版(0e061d3) vs 旧版(2ff6d0d) —— 证明 Nova 主题未被本次改动影响
 *  B) 新版(0e061d1) vs 生产站 —— 证明本地测试台与生产同源
 * 差异用浏览器 canvas 解码后逐像素统计，并输出差异区域包围盒。
 */

const NEW = "http://127.0.0.1:9311"
const OLD = "http://127.0.0.1:9312"
const PROD = "https://ciki.pama.workers.dev"

const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]

async function shoot(browser, base, cookieFile, style, mode, path, opts = {}) {
  const context = await newContext(browser, { width: 1440, height: 900 })
  if (cookieFile) await attachSession(context, cookieFile)
  else await context.addCookies([]) // 未登录
  await installTheme(context, style, mode)
  const page = await context.newPage()
  await goto(page, base, path, opts.wait)
  await page.waitForTimeout(600)
  const buf = await page.screenshot({ fullPage: Boolean(opts.fullPage) })
  const tokens = await page.evaluate(() => {
    const root = document.documentElement
    const out = {}
    for (const name of [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--popover",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--border",
      "--input",
      "--ring",
      "--radius"
    ]) {
      out[name] = getComputedStyle(root).getPropertyValue(name).trim()
    }
    out["__bodyBg"] = getComputedStyle(document.body).backgroundColor
    out["__bodyFg"] = getComputedStyle(document.body).color
    out["__fontSans"] = getComputedStyle(root).getPropertyValue("--font-sans-family").trim()
    out["__fontMono"] = getComputedStyle(root).getPropertyValue("--font-mono-family").trim()
    out["__dataTheme"] = root.getAttribute("data-theme")
    out["__dataMode"] = root.getAttribute("data-mode")
    return out
  })
  await context.close()
  return { buf, tokens }
}

/** 在浏览器里解两张 PNG，逐像素比 */
async function diffPixels(browser, a, b) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const result = await page.evaluate(
    async ([ab, bb]) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const img = new Image()
          img.onload = () => res(img)
          img.onerror = rej
          img.src = "data:image/png;base64," + b64
        })
      const [ia, ib] = await Promise.all([load(ab), load(bb)])
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return {
          sizeMismatch: true,
          a: { w: ia.width, h: ia.height },
          b: { w: ib.width, h: ib.height }
        }
      }
      const cv = (img) => {
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d")
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, img.width, img.height).data
      }
      const da = cv(ia)
      const db = cv(ib)
      let diff = 0
      let maxDelta = 0
      const regions = []
      let minX = Infinity,
        minY = Infinity,
        maxX = -1,
        maxY = -1
      const rowRuns = []
      let runStart = null
      for (let y = 0; y < ia.height; y++) {
        let rowHas = false
        for (let x = 0; x < ia.width; x++) {
          const i = (y * ia.width + x) * 4
          const d =
            Math.abs(da[i] - db[i]) +
            Math.abs(da[i + 1] - db[i + 1]) +
            Math.abs(da[i + 2] - db[i + 2])
          if (d > 0) {
            diff++
            rowHas = true
            if (d > maxDelta) maxDelta = d
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
        if (rowHas && runStart === null) runStart = y
        if (!rowHas && runStart !== null) {
          rowRuns.push([runStart, y - 1])
          runStart = null
        }
      }
      if (runStart !== null) rowRuns.push([runStart, ia.height - 1])
      // 合并相邻行段
      const merged = []
      for (const r of rowRuns) {
        const last = merged[merged.length - 1]
        if (last && r[0] <= last[1] + 2) last[1] = Math.max(last[1], r[1])
        else merged.push([...r])
      }
      for (const [y0, y1] of merged) {
        regions.push({ y0, y1 })
      }
      return {
        width: ia.width,
        height: ia.height,
        diffPixels: diff,
        totalPixels: ia.width * ia.height,
        ratio: Math.round((diff / (ia.width * ia.height)) * 1e6) / 1e6,
        maxDelta,
        bbox: diff ? { minX, minY, maxX, maxY } : null,
        rowBands: regions.slice(0, 40)
      }
    },
    [a.toString("base64"), b.toString("base64")]
  )
  await context.close()
  return result
}

const browser = await launch()
const report = {}

// --- A) 新 vs 旧（本地两套实例，Nova 主题） ---
for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const A = await shoot(browser, NEW, "/tmp/qa/cookies-new.json", combo.style, combo.mode, "/p/1", {
    wait: "h1",
    fullPage: true
  })
  const B = await shoot(browser, OLD, "/tmp/qa/cookies-old.json", combo.style, combo.mode, "/p/1", {
    wait: "h1",
    fullPage: true
  })
  const identical = A.buf.equals(B.buf)
  const diff = identical
    ? { diffPixels: 0, note: "字节完全一致" }
    : await diffPixels(browser, A.buf, B.buf)
  const tokenDiff = {}
  for (const k of Object.keys(A.tokens)) {
    if (A.tokens[k] !== B.tokens[k]) tokenDiff[k] = { new: A.tokens[k], old: B.tokens[k] }
  }
  report[`new-vs-old/${key}`] = {
    identicalBytes: identical,
    diff,
    tokenDiff,
    bytes: { new: A.buf.length, old: B.buf.length }
  }
  console.log(`new-vs-old/${key}: identical=${identical}`, JSON.stringify(diff).slice(0, 300))
  fs.writeFileSync(`${SHOTS}/cmp-new-vs-old-${key}-new.png`, A.buf)
  fs.writeFileSync(`${SHOTS}/cmp-new-vs-old-${key}-old.png`, B.buf)
}

// --- B) 新 vs 生产（登录页，公开页面对照） ---
for (const combo of [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" }
]) {
  const key = `${combo.style}-${combo.mode}`
  const A = await shoot(browser, NEW, null, combo.style, combo.mode, "/login", {
    wait: "form, body"
  })
  const B = await shoot(browser, PROD, null, combo.style, combo.mode, "/login", {
    wait: "form, body"
  })
  const identical = A.buf.equals(B.buf)
  const diff = identical ? { diffPixels: 0 } : await diffPixels(browser, A.buf, B.buf)
  const tokenDiff = {}
  for (const k of Object.keys(A.tokens)) {
    if (A.tokens[k] !== B.tokens[k]) tokenDiff[k] = { new: A.tokens[k], prod: B.tokens[k] }
  }
  report[`new-vs-prod/${key}`] = { identicalBytes: identical, diff, tokenDiff }
  console.log(`new-vs-prod/${key}: identical=${identical}`, JSON.stringify(diff).slice(0, 300))
  fs.writeFileSync(`${SHOTS}/cmp-new-vs-prod-${key}-new.png`, A.buf)
  fs.writeFileSync(`${SHOTS}/cmp-new-vs-prod-${key}-prod.png`, B.buf)
}

writeJson("/tmp/qa/compare.json", report)
await browser.close()
console.log("done")
