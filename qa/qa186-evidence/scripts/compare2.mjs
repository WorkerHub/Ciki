import fs from "node:fs"
import { launch, newContext, attachSession, installTheme, goto, writeJson, SHOTS } from "./lib.mjs"

/** 扩展对照：多个表面上「新版 vs 旧版」的 Nova 像素差与令牌差（排除页脚版本号后应≈0） */
const NEW = "http://127.0.0.1:9311"
const OLD = "http://127.0.0.1:9312"
const SURFACES = [
  { id: "read", path: "/p/1", wait: "h1" },
  { id: "home", path: "/", wait: "body" },
  { id: "notifications", path: "/notifications", wait: "body" },
  { id: "author", path: "/users/1", wait: "body" },
  { id: "admin-users", path: "/admin/users", wait: "body" },
  { id: "comments", path: "/p/1", wait: "[data-comment-composer]" }
]
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" }
]

const browser = await launch()

async function shoot(base, cookie, style, mode, s) {
  const context = await newContext(browser, { width: 1440, height: 900 })
  await attachSession(context, cookie)
  await installTheme(context, style, mode)
  const page = await context.newPage()
  await goto(page, base, s.path, s.wait)
  await page.waitForTimeout(700)
  const buf = await page.screenshot()
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
    ]) out[name] = getComputedStyle(root).getPropertyValue(name).trim()
    out.__bodyBg = getComputedStyle(document.body).backgroundColor
    out.__bodyFg = getComputedStyle(document.body).color
    out.__fontSans = getComputedStyle(root).getPropertyValue("--font-sans-family").trim()
    out.__fontMono = getComputedStyle(root).getPropertyValue("--font-mono-family").trim()
    return out
  })
  await context.close()
  return { buf, tokens }
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
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { sizeMismatch: true }
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
          const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
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
  for (const s of SURFACES) {
    const key = `${combo.style}-${combo.mode}/${s.id}`
    const A = await shoot(NEW, "/tmp/qa/cookies-new.json", combo.style, combo.mode, s)
    const B = await shoot(OLD, "/tmp/qa/cookies-old.json", combo.style, combo.mode, s)
    const d = await diff(A.buf, B.buf)
    const tokenDiff = {}
    for (const k of Object.keys(A.tokens))
      if (A.tokens[k] !== B.tokens[k]) tokenDiff[k] = { new: A.tokens[k], old: B.tokens[k] }
    report[key] = { diff: d, tokenDiff }
    fs.writeFileSync(`${SHOTS}/cmp2-${key.replace("/", "-")}-new.png`, A.buf)
    fs.writeFileSync(`${SHOTS}/cmp2-${key.replace("/", "-")}-old.png`, B.buf)
    console.log(
      key,
      "ratio=" + d.ratio,
      "px=" + d.diffPixels,
      "bbox=" + JSON.stringify(d.bbox),
      "tokens=" + Object.keys(tokenDiff).length
    )
  }
}
writeJson("/tmp/qa/compare2.json", report)
await browser.close()
console.log("done")
