/**
 * QA #182 裁剪面审计：真浏览器记录 overflow-x 裁剪面的位置迁移是否落地。
 * - [data-page-canvas] 的 computed overflowX（基线=clip，返工=visible）
 * - 正文内容列包装层（.wiki-content 的最近 min-w-0 祖先）computed overflowX（返工=clip）
 * - textarea / 评论区 section 全部祖先链的横向裁剪审计（返工后应为空 = 无任何裁剪祖先）
 * 用法: node qa182-clip-audit.mjs <port> <tag>
 */
import { chromium } from "playwright"
import fs from "node:fs"

const port = process.argv[2] ?? "8907"
const tag = process.argv[3] ?? "base"
const BASE = `http://127.0.0.1:${port}`
const OUT = `/tmp/qa182/evidence-${tag}`
fs.mkdirSync(OUT, { recursive: true })

async function loginState() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "jim@example.com", password: "JimPass123!" })
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const m = /ciki_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")
  if (!m) throw new Error("no session cookie")
  return [{ name: "ciki_session", value: m[1], domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 * 7, httpOnly: true, secure: false, sameSite: "Lax" }]
}

const measure = () => {
  const clipChain = (el) => {
    const chain = []
    let cur = el ? el.parentElement : null
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur)
      if (cs.overflowX !== "visible") {
        chain.push({
          tag: cur.tagName.toLowerCase(),
          clipX: cs.overflowX,
          clipY: cs.overflowY,
          klass: typeof cur.className === "string" ? cur.className.slice(0, 100) : "",
          marker: cur.getAttribute("data-page-canvas") === "" ? "page-canvas" : (cur.getAttribute("data-comment-composer") === "" ? "comment-composer" : "")
        })
      }
      cur = cur.parentElement
    }
    return chain
  }
  const canvas = document.querySelector("[data-page-canvas]")
  const ta = document.querySelector('textarea[data-slot="textarea"]')
  const section = document.querySelector('section[aria-labelledby="comments-heading"]')
  const wiki = document.querySelector(".wiki-content")
  const contentWrapper = wiki ? wiki.closest(".min-w-0") : null
  const cs = (el) => el ? { overflowX: getComputedStyle(el).overflowX, overflowY: getComputedStyle(el).overflowY } : null
  return {
    canvas: cs(canvas),
    canvasKlass: canvas ? String(canvas.className) : "",
    contentWrapper: cs(contentWrapper),
    contentWrapperKlass: contentWrapper ? String(contentWrapper.className) : "",
    textareaClipAncestors: clipChain(ta),
    commentSectionClipAncestors: clipChain(section)
  }
}

const cookie = await loginState()
const VIEWPORTS = [
  { key: "m375", width: 375, height: 812, mobile: true },
  { key: "m390", width: 390, height: 844, mobile: true },
  { key: "desk", width: 1440, height: 900, mobile: false }
]
const THEMES = ["light", "dark"]
const out = { tag, port, combos: {} }

const browser = await chromium.launch()
try {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      if (theme === "dark" && vp.key === "m375") continue
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        ...(vp.mobile ? { isMobile: true, hasTouch: true } : {}),
        storageState: { cookies: cookie, origins: [{ origin: BASE, localStorage: [{ name: "ciki-theme", value: theme }] }] }
      })
      const page = await ctx.newPage()
      const T = `${vp.key}-${theme}`
      await page.goto(`${BASE}/p/1`, { waitUntil: "domcontentloaded" })
      await page.locator("h1", { hasText: "聚焦环验收页" }).waitFor({ timeout: 20000 })
      await page.waitForSelector('textarea[data-slot="textarea"]', { timeout: 15000 })
      await page.waitForTimeout(500)

      const info = await page.evaluate(measure)
      out.combos[T] = info
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}

fs.writeFileSync(`${OUT}/clip-audit.json`, JSON.stringify(out, null, 2))
for (const [k, v] of Object.entries(out.combos)) {
  console.log(`[${k}] canvas.overflowX=${v.canvas?.overflowX} contentWrapper.overflowX=${v.contentWrapper?.overflowX} taClipAncestors=${v.textareaClipAncestors.length} secClipAncestors=${v.commentSectionClipAncestors.length}`)
  console.log(`    taClip: ${JSON.stringify(v.textareaClipAncestors)}`)
  console.log(`    secClip: ${JSON.stringify(v.commentSectionClipAncestors)}`)
}
console.log(`\nclip-audit -> ${OUT}/clip-audit.json`)
