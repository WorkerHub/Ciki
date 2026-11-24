import { launch, newContext, attachSession, installTheme } from "./lib.mjs"

/** 复刻 matrix 的单页串行导航，逐表面定位 pageerror 来源（新旧构建对照） */
const SURFACES = [
  { id: "read", path: "/p/1", wait: "h1" },
  { id: "edit", path: "/p/1/edit", wait: ".ProseMirror" },
  { id: "comments", path: "/p/1", wait: "[data-comment-composer]", scrollTo: "[data-comment-composer]" },
  { id: "notif-panel", path: "/p/1", wait: "h1", bell: true },
  { id: "notif-page", path: "/notifications", wait: "main, body" },
  { id: "author", path: "/users/1", wait: "main, body" },
  { id: "settings", path: "/settings", wait: "main, body" },
  { id: "admin-users", path: "/admin/users", wait: "main, body" },
  { id: "admin-site", path: "/admin/site", wait: "main, body" }
]
const TARGETS = [
  { name: "old-2ff6d0d", base: "http://127.0.0.1:9312", cookie: "/tmp/qa/cookies-old.json" },
  { name: "new-0e061d3", base: "http://127.0.0.1:9311", cookie: "/tmp/qa/cookies-new.json" }
]
const browser = await launch()
for (const t of TARGETS) {
  console.log("###", t.name)
  const context = await newContext(browser, { width: 1440, height: 900 })
  await attachSession(context, t.cookie)
  const page = await context.newPage()
  let current = "init"
  const buckets = {}
  page.on("pageerror", (e) => {
    ;(buckets[current] ||= []).push("pageerror: " + String(e.message).slice(0, 140))
  })
  page.on("console", (m) => {
    if (m.type() === "error") (buckets[current] ||= []).push("console: " + m.text().slice(0, 140))
  })
  for (const s of SURFACES) {
    current = s.id
    await page.goto(`${t.base}${s.path}`, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.waitForSelector(s.wait, { timeout: 20000 }).catch(() => {})
    if (s.scrollTo) await page.locator(s.scrollTo).first().scrollIntoViewIfNeeded().catch(() => {})
    if (s.bell) {
      await page.getByRole("button", { name: "通知" }).first().click().catch(() => {})
    }
    await page.waitForTimeout(2500)
  }
  for (const [k, v] of Object.entries(buckets)) console.log(` ${k}: ${v.length}`, JSON.stringify([...new Set(v)]).slice(0, 400))
  await context.close()
}
await browser.close()
