// QA #232 强制竞态测试（本单新增，非首轮工装）：
// 给 /api/spaces 注入 300ms 延迟，令「页面数据先到、空间数据后到」确定性成立；
// 重载 12 次采样初始标签。若哨兵逻辑只在自然时序下偶然成立，此处必然复现旧缺陷。
// 验后拔除钩子并核验（钩子=页内 JS 覆盖 fetch，不碰产品代码）。
// 用法：node run-race.mjs <base-url> <origin-name> <page-id>
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync } from "node:fs"
import { launchOptions } from "./lib.mjs"

const [, , baseUrl, originName, pageIdArg] = process.argv
const PAGE_ID = Number(pageIdArg)
const EDIT_URL = `${baseUrl}/p/${PAGE_ID}/edit`
const RELOADS = Number(process.env.QA_RACE_RELOADS || 12)
const DELAY = 300
const OUT = "/tmp/ciki-qa232"

const out = { origin: originName, pageId: PAGE_ID, delayMs: DELAY, reloads: RELOADS, results: [], hookCheck: null }
const browser = await chromium.launch(launchOptions())
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  reducedMotion: "reduce"
})
await context.addInitScript((delay) => {
  // 自适应采样（同 run-main）：首见工具条后 extra ms 结束；max ms 无工具条则 noToolbar。
  window.__qaSample = (extra, max) =>
    new Promise((resolve) => {
      const readLabel = () => {
        const el = document.querySelector('[aria-label="段落样式"]')
        if (!el) return null
        const sv = el.querySelector("[data-slot]")
        return (sv ?? el).textContent?.trim() ?? null
      }
      const t0 = performance.now()
      const samples = []
      let seen = false
      let seenAt = 0
      const tick = () => {
        const label = readLabel()
        if (label !== null) {
          if (!seen) {
            seen = true
            seenAt = performance.now() - t0
          }
          samples.push({ t: Math.round(performance.now() - t0), label })
        }
        const elapsed = performance.now() - t0
        if (seen && elapsed - seenAt >= extra)
          resolve({
            samples,
            distinct: [...new Set(samples.map((s) => s.label))],
            firstAt: Math.round(seenAt),
            lastAt: Math.round(elapsed),
            noToolbar: false
          })
        else if (!seen && elapsed >= max)
          resolve({ samples, distinct: [], firstAt: null, lastAt: null, noToolbar: true })
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  // ── 延迟钩子：页内 JS 覆盖 fetch，只拖慢 /api/spaces ──
  const origFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? ""
    if (url.includes("/api/spaces")) {
      await new Promise((r) => setTimeout(r, delay))
    }
    return origFetch(...args)
  }
}, DELAY)

try {
  const page = await context.newPage()
  // 登录态：新 context 无 cookie，先 UI 真实登录
  const me = await page.request.get(`${baseUrl}/api/me`)
  if (!me.ok()) {
    const pass = readFileSync(process.argv[5], "utf8").trim()
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" })
    await page.fill('input[name="email"]', "qa232@ciki-qa.test")
    await page.fill('input[name="password"]', pass)
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }),
      page.click('button[type="submit"]')
    ])
    console.log("race login ok:", page.url())
  }
  for (let i = 1; i <= RELOADS; i++) {
    await page.goto(EDIT_URL, { waitUntil: "domcontentloaded" })
    const s = await page.evaluate((w) => window.__qaSample(w.extra, w.max), { extra: 3000, max: 15000 })
    if (!s || s.noToolbar) {
      out.results.push({ run: i, distinct: [s && s.noToolbar ? "<no-toolbar>" : "<no-sample>"], ok: false })
      console.log(`race#${i} FAIL ${s && s.noToolbar ? "noToolbar(15s)" : "no-sample"}`)
      continue
    }
    const ok = s.distinct.length === 1 && s.distinct[0] === "正文"
    out.results.push({ run: i, distinct: s.distinct, n: s.samples.length, firstAt: s.firstAt, lastAt: s.lastAt, ok })
    console.log(`race#${i} ${ok ? "PASS" : "FAIL"} distinct=${JSON.stringify(s.distinct)} n=${s.samples.length} 首见=${s.firstAt}ms 末见=${s.lastAt}ms`)
  }
  const allOk = out.results.every((r) => r.ok !== false && r.distinct?.[0] === "正文")
  console.log(`\n== 强制竞态(延迟${DELAY}ms) ${originName}: ${out.results.filter((r) => r.ok).length}/${RELOADS} PASS ==`)

  // 钩子核验：新开 about:blank 页（同 context，initScript 生效），请求生产真接口，
  // 比较有钩/无钩耗时 → 证明钩子真实生效过，随后拔除（用第二个 context 无 initScript 对照）。
  const plain = await browser.newContext({ serviceWorkers: "block" })
  const p2 = await plain.newPage()
  const t1 = Date.now()
  await p2.goto(`${baseUrl}/api/spaces`, { waitUntil: "commit" }).catch(() => {})
  const baseMs = Date.now() - t1
  await plain.close()

  const probe = await context.newPage()
  await probe.goto("about:blank")
  const hooked = await probe.evaluate(async (d) => {
    const t = Date.now()
    await fetch("/api/spaces").catch(() => {})
    return Date.now() - t
  }, DELAY)
  out.hookCheck = { baseMs, hookedMs: hooked, delayMs: DELAY, hookProven: hooked >= DELAY }
  console.log(`钩子核验: 对照基线≈${baseMs}ms(导航含握手), 钩内 fetch=${hooked}ms (≥${DELAY}ms 即证明钩子全程生效)`)
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err)
  console.log("FATAL:", out.fatal)
} finally {
  writeFileSync(`${OUT}/race-${originName}.json`, JSON.stringify(out, null, 2))
  await browser.close().catch(() => {})
}
process.exit(0)
