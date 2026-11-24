import fs from "node:fs"
import {
  launch,
  newContext,
  attachSession,
  goto,
  installTheme,
  writeJson,
  SHOTS
} from "./lib.mjs"

/** 四种组合下，逐块截图：代码块 / 表格 / Excalidraw 画布 / HTML Embed */
const BASE = "http://127.0.0.1:9311"
const COOKIE = "/tmp/qa/cookies-new.json"
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
  const dir = `${SHOTS}/blocks/${key}`
  fs.mkdirSync(dir, { recursive: true })
  const context = await newContext(browser, { width: 1440, height: 900 })
  await attachSession(context, COOKIE)
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  await goto(page, BASE, "/p/1", "h1")
  await page.waitForTimeout(800)

  const targets = {
    code: ".wiki-content .code-block",
    table: ".wiki-content table",
    canvas: "[data-excalidraw-block]",
    embed: ".wiki-content iframe"
  }
  const entry = {}
  for (const [name, sel] of Object.entries(targets)) {
    const loc = page.locator(sel).first()
    const count = await page.locator(sel).count()
    if (!count) {
      entry[name] = { found: false }
      continue
    }
    await loc.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await loc.screenshot({ path: `${dir}/${name}.png` }).catch(() => {})
    const info = await loc.evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName,
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        bg: cs.backgroundColor,
        border: cs.border,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow.slice(0, 80),
        overflowX: cs.overflowX
      }
    })
    entry[name] = { found: true, ...info }
  }

  // 画布预览图是否真的可见（自然尺寸非 0）
  entry.canvasPreview = await page.evaluate(() => {
    const img = document.querySelector("[data-excalidraw-block] img")
    if (!img) return { found: false }
    const r = img.getBoundingClientRect()
    return {
      found: true,
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      rendered: { w: Math.round(r.width), h: Math.round(r.height) },
      src: img.getAttribute("src"),
      complete: img.complete
    }
  })

  // Embed iframe 内部文档（主题不注入外部 HTML）
  const frames = page.frames()
  entry.embedFrame = []
  for (const f of frames) {
    if (f === page.mainFrame()) continue
    try {
      entry.embedFrame.push(
        await f.evaluate(() => ({
          url: location.href,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          bodyFg: getComputedStyle(document.body).color,
          text: document.body.innerText.slice(0, 40)
        }))
      )
    } catch (e) {
      entry.embedFrame.push({ url: f.url(), error: String(e.message).slice(0, 80) })
    }
  }

  report[key] = entry
  console.log(key, JSON.stringify(entry).slice(0, 400))
  await context.close()
}

writeJson("/tmp/qa/blocks.json", report)
await browser.close()
console.log("done")
