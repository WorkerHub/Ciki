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

/** 移动端壳实测：390×844，触摸，含横向溢出与导航壳检查 */
const BASE = process.env.QA_BASE || "http://127.0.0.1:9311"
const COOKIE = process.env.QA_COOKIE || "/tmp/qa/cookies-new.json"
const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]
const SURFACES = [
  { id: "home", path: "/", wait: "body" },
  { id: "read", path: "/p/1", wait: "h1" },
  { id: "read-full", path: "/p/1", wait: "h1", fullPage: true },
  { id: "edit", path: "/p/1/edit", wait: ".ProseMirror" },
  { id: "comments", path: "/p/1", wait: "[data-comment-composer]", scrollTo: "[data-comment-composer]" },
  { id: "notifications", path: "/notifications", wait: "body" },
  { id: "settings", path: "/settings", wait: "body" }
]

const browser = await launch()
const report = {}

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const dir = `${SHOTS}/mobile/${key}`
  fs.mkdirSync(dir, { recursive: true })
  const context = await newContext(browser, { width: 390, height: 844, dsf: 2, mobile: true })
  await attachSession(context, COOKIE)
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e.message)))
  const entry = { combo, surfaces: {}, errors }
  for (const s of SURFACES) {
    await goto(page, BASE, s.path, s.wait)
    if (s.scrollTo) {
      await page.locator(s.scrollTo).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
    }
    const attrs = await themeAttrs(page)
    const layout = await page.evaluate(() => {
      const doc = document.documentElement
      const overflowing = [...document.querySelectorAll("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)
        })
        .slice(0, 6)
        .map((el) => ({
          tag: el.tagName,
          cls: String(el.className).slice(0, 60),
          right: Math.round(el.getBoundingClientRect().right),
          left: Math.round(el.getBoundingClientRect().left)
        }))
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: doc.scrollWidth,
        horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
        overflowing,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        fontSize: getComputedStyle(document.body).fontSize,
        touchTargets: [...document.querySelectorAll("header button, nav button, [role=tab]")]
          .slice(0, 12)
          .map((b) => {
            const r = b.getBoundingClientRect()
            return { label: (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) }
          })
      }
    })
    await page.screenshot({
      path: `${dir}/${s.id}.png`,
      fullPage: Boolean(s.fullPage)
    })
    entry.surfaces[s.id] = { attrs, layout }
    process.stdout.write(`  mobile/${key}/${s.id} ok\n`)
  }
  report[key] = entry
  await context.close()
}

writeJson("/tmp/qa/mobile.json", report)
await browser.close()
console.log("done")
