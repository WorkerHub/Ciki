import fs from "node:fs"
import { launch, newContext, attachSession, goto, installTheme, SHOTS } from "./lib.mjs"

/** 1) 纸面/nova 阅读页整页（内滚动容器 → 用高视口 + 元素截图） 2) 与参考站并排对照图 */
const BASE = "http://127.0.0.1:9311"
const COOKIE = "/tmp/qa/cookies-new.json"
const OUT = `${SHOTS}/final`
fs.mkdirSync(OUT, { recursive: true })

const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]

const browser = await launch()

// —— 1. 四格阅读页整页截图 ——
for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const context = await newContext(browser, { width: 1440, height: 1800 })
  await attachSession(context, COOKIE)
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  await goto(page, BASE, "/p/1", "h1")
  await page.waitForTimeout(900)
  const content = page.locator(".wiki-content").first()
  await content.screenshot({ path: `${OUT}/read-${key}.png` })
  console.log("read", key, "ok")
  await context.close()
}

// —— 2. 并排对照图（参考站 vs 纸面） ——
const pairs = [
  { ref: `${SHOTS}/reference/light-viewport.png`, paper: `${OUT}/read-paper-light.png`, out: `${OUT}/side-by-side-light.png`, label: "浅色" },
  { ref: `${SHOTS}/reference/dark-viewport.png`, paper: `${OUT}/read-paper-dark.png`, out: `${OUT}/side-by-side-dark.png`, label: "暗色" }
]

for (const p of pairs) {
  const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#111;color:#eee;font:14px -apple-system,"PingFang SC",sans-serif}
    .row{display:flex;gap:12px;padding:12px;align-items:flex-start}
    .col{flex:1;min-width:0}
    h2{font-size:15px;margin:0 0 8px;font-weight:600}
    .frame{border:1px solid #444;background:#000;overflow:hidden;max-height:900px}
    img{display:block;width:100%}
  </style></head><body>
  <div class="row">
    <div class="col"><h2>参考站 byte-sized-algorithms（${p.label}）</h2><div class="frame"><img src="${b64(p.ref)}"></div></div>
    <div class="col"><h2>Ciki 纸面主题（${p.label}）</h2><div class="frame"><img src="${b64(p.paper)}"></div></div>
  </div></body></html>`
  const context = await newContext(browser, { width: 1600, height: 960 })
  const page = await context.newPage()
  await page.setContent(html)
  await page.waitForTimeout(600)
  await page.screenshot({ path: p.out, fullPage: true })
  console.log("pair", p.out, "ok")
  await context.close()
}

await browser.close()
console.log("done")
