import fs from "node:fs"
import {
  launch,
  newContext,
  attachSession,
  goto,
  themeAttrs,
  installTheme,
  writeJson,
  SHOTS
} from "./lib.mjs"

const BASE = process.env.QA_BASE || "http://127.0.0.1:9311"
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]
// nova 只取代表面，paper 取全部表面
const FULL_SURFACES = process.env.QA_FULL === "1"
const COOKIE_FILE = process.env.QA_COOKIE || "/tmp/qa/cookies.json"

const SURFACES = [
  { id: "read", path: "/p/1", wait: "h1", fullPage: true },
  { id: "edit", path: "/p/1/edit", wait: ".ProseMirror", fullPage: true },
  { id: "comments", path: "/p/1", wait: "[data-comment-composer]", scrollTo: "[data-comment-composer]" },
  { id: "notif-panel", path: "/p/1", wait: "h1", bell: true },
  { id: "notif-page", path: "/notifications", wait: "main, body", fullPage: true },
  { id: "author", path: "/users/1", wait: "main, body", fullPage: true },
  { id: "settings", path: "/settings", wait: "[aria-label='风格']", fullPage: true },
  { id: "admin-users", path: "/admin/users", wait: "main, body", fullPage: true },
  { id: "admin-spaces", path: "/admin/spaces", wait: "main, body", fullPage: true },
  { id: "admin-site", path: "/admin/site", wait: "main, body", fullPage: true },
  { id: "admin-security", path: "/admin/security", wait: "main, body", fullPage: true },
  { id: "admin-email", path: "/admin/email", wait: "main, body", fullPage: true },
  { id: "admin-others", path: "/admin/others", wait: "main, body", fullPage: true }
]

/** 读页上的配色与度量（令牌 + 关键元素计算样式 + 对比度） */
async function readMetrics(page) {
  return await page.evaluate(() => {
    const cs = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : null)
    const px = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || "")
      if (!m) return null
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] }
    }
    const lum = (c) => {
      const p = px(c)
      if (!p) return null
      const f = (v) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b)
    }
    const contrast = (fg, bg) => {
      const l1 = lum(fg)
      const l2 = lum(bg)
      if (l1 === null || l2 === null) return null
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    const root = document.documentElement
    const tokens = {}
    for (const name of [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--muted",
      "--muted-foreground",
      "--primary",
      "--primary-foreground",
      "--border",
      "--ring",
      "--radius"
    ]) {
      tokens[name] = cs(root, name)
    }
    const body = document.body
    const para = document.querySelector(".wiki-content p")
    const pre = document.querySelector(".wiki-content .code-block > pre")
    const code = document.querySelector(".wiki-content .code-block > pre > code")
    const kw = document.querySelector(".wiki-content .code-block pre code .hljs-keyword")
    const str = document.querySelector(".wiki-content .code-block pre code .hljs-string")
    const cmt = document.querySelector(".wiki-content .code-block pre code .hljs-comment")
    const th = document.querySelector(".wiki-content table th")
    const td = document.querySelector(".wiki-content table td")
    const table = document.querySelector(".wiki-content table")
    const canvasImg = document.querySelector(".wiki-content img[data-type='excalidraw']")
    const iframe = document.querySelector(".wiki-content iframe")
    const quote = document.querySelector(".wiki-content blockquote")
    const inlineCode = document.querySelector(".wiki-content p code")

    const bgOf = (el) => {
      if (!el) return null
      let n = el
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor
        const p = px(c)
        if (p && p.a > 0) return c
        n = n.parentElement
      }
      return getComputedStyle(body).backgroundColor
    }

    return {
      tokens,
      bodyBg: getComputedStyle(body).backgroundColor,
      bodyFg: getComputedStyle(body).color,
      bodyFontFamily: getComputedStyle(body).fontFamily,
      paraFontFamily: para ? getComputedStyle(para).fontFamily : null,
      paraFontSize: para ? getComputedStyle(para).fontSize : null,
      paraColor: para ? getComputedStyle(para).color : null,
      paraBg: bgOf(para),
      paraContrast: para ? contrast(getComputedStyle(para).color, bgOf(para)) : null,
      code: {
        bg: pre ? getComputedStyle(pre).backgroundColor : null,
        fg: code ? getComputedStyle(code).color : null,
        fontFamily: pre ? getComputedStyle(pre).fontFamily : null,
        contrast: pre && code ? contrast(getComputedStyle(code).color, bgOf(pre)) : null,
        keyword: kw ? getComputedStyle(kw).color : null,
        string: str ? getComputedStyle(str).color : null,
        comment: cmt ? getComputedStyle(cmt).color : null,
        headerBg: pre
          ? getComputedStyle(pre.parentElement || pre).backgroundColor
          : null,
        border: pre ? getComputedStyle(pre).borderTopColor : null
      },
      table: {
        headerBg: th ? getComputedStyle(th).backgroundColor : null,
        headerFg: th ? getComputedStyle(th).color : null,
        cellFg: td ? getComputedStyle(td).color : null,
        border: table ? getComputedStyle(table).borderTopColor : null,
        borderCell: td ? getComputedStyle(td).borderTopColor : null,
        headerContrast: th ? contrast(getComputedStyle(th).color, bgOf(th)) : null,
        cellContrast: td ? contrast(getComputedStyle(td).color, bgOf(td)) : null
      },
      canvas: {
        border: canvasImg ? getComputedStyle(canvasImg).borderTopColor : null,
        borderWidth: canvasImg ? getComputedStyle(canvasImg).borderTopWidth : null,
        bg: canvasImg ? getComputedStyle(canvasImg).backgroundColor : null,
        radius: canvasImg ? getComputedStyle(canvasImg).borderTopLeftRadius : null,
        w: canvasImg ? canvasImg.getBoundingClientRect().width : null,
        h: canvasImg ? canvasImg.getBoundingClientRect().height : null
      },
      embed: {
        border: iframe ? getComputedStyle(iframe).borderTopColor : null,
        borderWidth: iframe ? getComputedStyle(iframe).borderTopWidth : null,
        radius: iframe ? getComputedStyle(iframe).borderTopLeftRadius : null,
        h: iframe ? iframe.getBoundingClientRect().height : null
      },
      quote: {
        bg: quote ? getComputedStyle(quote).backgroundColor : null,
        border: quote ? getComputedStyle(quote).borderLeftColor : null,
        fg: quote ? getComputedStyle(quote).color : null
      },
      inlineCode: inlineCode
        ? {
            bg: getComputedStyle(inlineCode).backgroundColor,
            fg: getComputedStyle(inlineCode).color,
            family: getComputedStyle(inlineCode).fontFamily,
            contrast: contrast(
              getComputedStyle(inlineCode).color,
              bgOf(inlineCode)
            )
          }
        : null,
      // 纸纹理：伪元素/背景图是否存在（纸面主题才有）
      texture: {
        bodyBackgroundImage: getComputedStyle(body).backgroundImage.slice(0, 160),
        wikiBackgroundImage: (() => {
          const w = document.querySelector(".wiki-content")
          return w ? getComputedStyle(w).backgroundImage.slice(0, 160) : null
        })(),
        htmlBackgroundImage: getComputedStyle(root).backgroundImage.slice(0, 160)
      }
    }
  })
}

const browser = await launch()
const report = {}

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const dir = `${SHOTS}/${key}`
  fs.mkdirSync(dir, { recursive: true })
  const context = await newContext(browser)
  await installTheme(context, combo.style, combo.mode)
  await attachSession(context, COOKIE_FILE)
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e.message)))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`)
  })

  const surfaces = FULL_SURFACES
    ? SURFACES
    : SURFACES.filter((s) =>
        ["read", "settings", "admin-site", "comments"].includes(s.id)
      )

  const entry = { combo, surfaces: {}, errors }
  for (const s of surfaces) {
    await goto(page, BASE, s.path, s.wait)
    if (s.scrollTo) {
      await page.locator(s.scrollTo).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
    }
    if (s.bell) {
      const bell = page.getByRole("button", { name: "通知" }).filter({ visible: true }).first()
      await bell.click()
      await page.waitForTimeout(800)
    }
    const attrs = await themeAttrs(page)
    const metrics = s.id === "read" ? await readMetrics(page) : null
    await page.screenshot({
      path: `${dir}/${s.id}.png`,
      fullPage: Boolean(s.fullPage)
    })
    entry.surfaces[s.id] = { attrs, metrics }
    process.stdout.write(`  ${key}/${s.id} ok\n`)
  }
  report[key] = entry
  await context.close()
}

writeJson("/tmp/qa/matrix-new.json", report)
await browser.close()
console.log("done")
