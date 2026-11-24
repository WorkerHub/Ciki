import fs from "node:fs"
import { launch, newContext, installTheme, writeJson, SHOTS } from "./lib.mjs"

/** 生产 vs 本地 登录页：等表单真正渲染完再做像素与令牌对照（修正上一轮“加载中”截图造成的假差异） */
const NEW = "http://127.0.0.1:9311"
const PROD = "https://ciki.pama.workers.dev"
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" }
]
const browser = await launch()

async function shoot(base, style, mode) {
  const context = await newContext(browser, { width: 1440, height: 900 })
  await installTheme(context, style, mode)
  const page = await context.newPage()
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector('input[type="email"], input[type="text"]', { timeout: 30000 })
  await page.waitForTimeout(2500)
  const buf = await page.screenshot()
  const info = await page.evaluate(() => {
    const root = document.documentElement
    const cs = (n) => getComputedStyle(root).getPropertyValue(n).trim()
    const btn = document.querySelector('button[type="submit"]')
    return {
      dataTheme: root.getAttribute("data-theme"),
      dataMode: root.getAttribute("data-mode"),
      dark: root.classList.contains("dark"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      bodyFont: getComputedStyle(document.body).fontFamily,
      tokens: Object.fromEntries(
        [
          "--background",
          "--foreground",
          "--card",
          "--primary",
          "--primary-foreground",
          "--secondary",
          "--muted",
          "--muted-foreground",
          "--accent",
          "--border",
          "--ring",
          "--radius",
          "--font-sans-family"
        ].map((n) => [n, cs(n)])
      ),
      submitBtn: btn
        ? {
            bg: getComputedStyle(btn).backgroundColor,
            fg: getComputedStyle(btn).color,
            radius: getComputedStyle(btn).borderRadius
          }
        : null,
      footer: document.querySelector("footer")?.innerText?.trim().slice(0, 120) || null
    }
  })
  await context.close()
  return { buf, info }
}

async function diff(a, b) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const r = await page.evaluate(
    async ([ab, bb]) => {
      const load = (s) =>
        new Promise((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = rej
          i.src = "data:image/png;base64," + s
        })
      const [ia, ib] = await Promise.all([load(ab), load(bb)])
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true }
      const cv = (img) => {
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const x = c.getContext("2d")
        x.drawImage(img, 0, 0)
        return x.getImageData(0, 0, img.width, img.height).data
      }
      const da = cv(ia), db = cv(ib)
      let diff = 0, maxDelta = 0
      let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
      for (let y = 0; y < ia.height; y++)
        for (let x = 0; x < ia.width; x++) {
          const i = (y * ia.width + x) * 4
          const d =
            Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
          if (d > 0) {
            diff++
            if (d > maxDelta) maxDelta = d
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      return {
        width: ia.width,
        height: ia.height,
        diffPixels: diff,
        totalPixels: ia.width * ia.height,
        ratio: Math.round((diff / (ia.width * ia.height)) * 1e6) / 1e6,
        maxDelta,
        bbox: maxX < 0 ? null : { minX, minY, maxX, maxY }
      }
    },
    [a.toString("base64"), b.toString("base64")]
  )
  await context.close()
  return r
}

const report = {}
for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const A = await shoot(NEW, combo.style, combo.mode)
  const B = await shoot(PROD, combo.style, combo.mode)
  const d = await diff(A.buf, B.buf)
  const tokenDiff = {}
  for (const k of Object.keys(A.info.tokens))
    if (A.info.tokens[k] !== B.info.tokens[k]) tokenDiff[k] = { local: A.info.tokens[k], prod: B.info.tokens[k] }
  const metaDiff = {}
  for (const k of ["dataTheme", "dataMode", "dark", "bodyBg", "bodyFg", "bodyFont"]) {
    if (A.info[k] !== B.info[k]) metaDiff[k] = { local: A.info[k], prod: B.info[k] }
  }
  if (JSON.stringify(A.info.submitBtn) !== JSON.stringify(B.info.submitBtn))
    metaDiff.submitBtn = { local: A.info.submitBtn, prod: B.info.submitBtn }
  report[key] = { diff: d, tokenDiff, metaDiff, footer: { local: A.info.footer, prod: B.info.footer } }
  fs.writeFileSync(`${SHOTS}/prodcmp-${key}-local.png`, A.buf)
  fs.writeFileSync(`${SHOTS}/prodcmp-${key}-prod.png`, B.buf)
  console.log(key, "ratio=" + d.ratio, "px=" + d.diffPixels, "bbox=" + JSON.stringify(d.bbox))
  console.log("   tokenDiff:", JSON.stringify(tokenDiff))
  console.log("   metaDiff:", JSON.stringify(metaDiff))
  console.log("   footer local:", A.info.footer, "| prod:", B.info.footer)
}
writeJson("/tmp/qa/prod-compare2.json", report)
await browser.close()
console.log("done")
