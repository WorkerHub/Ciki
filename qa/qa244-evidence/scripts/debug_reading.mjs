/** 调试：阅读态 iframe 结构、src、postMessage 高度协议 */
import fs from "node:fs"
import { chromium } from "playwright-core"

const EXEC =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const state = JSON.parse(fs.readFileSync("/tmp/qa244-state.json", "utf8"))
const BASE = state.base
const HOST = new URL(BASE).host

const browser = await chromium.launch({
  headless: true,
  executablePath: EXEC,
  proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" },
})
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } })
await context.addCookies([
  { name: "ciki_session", value: state.sessionToken, domain: HOST, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
])
const page = await context.newPage()

// 在文档创建早期注入 message 监听，捕获 ciki-embed-height 协议消息
await context.addInitScript(() => {
  window.__qa244Messages = []
  window.addEventListener("message", (event) => {
    try {
      if (event.data && typeof event.data === "object") {
        window.__qa244Messages.push({ type: event.data.type, height: event.data.height ?? null, ts: Date.now() })
      }
    } catch {}
  })
})

await page.goto(`${BASE}/p/${state.pageId}`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(6000)

const dump = await page.evaluate(() => {
  const iframes = [...document.querySelectorAll("iframe")]
  return {
    url: location.href,
    iframeCount: iframes.length,
    iframes: iframes.map((f) => {
      const box = f.getBoundingClientRect()
      const style = getComputedStyle(f)
      let docErr = null
      let docTitle = null
      try {
        docTitle = f.contentDocument?.title ?? null
      } catch (e) {
        docErr = String(e && e.message ? e.message : e)
      }
      return {
        src: f.getAttribute("src"),
        dataAttrs: [...f.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name}=${a.value}`),
        sandbox: f.getAttribute("sandbox"),
        borderBox: { w: Math.round(box.width * 100) / 100, h: Math.round(box.height * 100) / 100 },
        styleHeight: style.height,
        docAccessible: docErr === null,
        docErr,
        docTitle,
      }
    }),
    messages: window.__qa244Messages,
  }
})
console.log(JSON.stringify(dump, null, 2))

// 若 src 可取，直接 GET 验证内容（同源或跨源都可以经 page.request）
const src = dump.iframes[0]?.src
if (src) {
  const res = await page.request.get(src)
  const body = await res.text()
  console.log("iframe src GET:", res.status(), "len:", body.length)
  console.log("含 QA244-EMBED-MARKER:", body.includes("QA244-EMBED-MARKER"))
  console.log("含 ciki-embed-height 上报脚本:", body.includes("ciki-embed-height"))
  console.log("含 sandbox CSP:", body.slice(0, 600))
  console.log("头 500 字:", body.slice(0, 500))
}

await browser.close()
