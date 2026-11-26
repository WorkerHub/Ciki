// 验收标准 3 补充：1280px 断点两侧的目录轨与正文列宽
import { chromium } from "playwright-core"
import fs from "node:fs"
const EXEC = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
const BASE = process.env.QA_BASE, TOKEN = process.env.QA_TOKEN, PAGE = process.env.QA_PAGE, PROXY = process.env.QA_PROXY || ""
const HOST = new URL(BASE).hostname
const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const out = []
for (const w of [1100, 1279, 1280, 1440, 1920]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: "block", ...(PROXY ? { proxy: { server: PROXY, bypass: "127.0.0.1,localhost" } } : {}) })
  await ctx.addCookies([{ name: "ciki_session", value: TOKEN, domain: HOST, path: "/" }])
  await ctx.addInitScript(() => { try { localStorage.setItem("ciki-theme", JSON.stringify({ state: { mode: "light", style: "nova", migratedAt: 1, modeMigratedAt: 1 }, version: 0 })) } catch (_) {} })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/p/${PAGE}`, { waitUntil: "load", timeout: 90000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="button"]').length > 0, null, { timeout: 25000 }).catch(() => {})
  await page.waitForSelector(".wiki-content", { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(800)
  const r = await page.evaluate(() => {
    const aside = document.querySelector('[aria-label*="目录"], aside[class*="ml-8"], nav')
    const canvas = document.querySelector("[data-page-canvas]")
    const wiki = document.querySelector(".wiki-content")
    const container = document.querySelector("[data-readview-container]")
    const rect = (e) => e ? { left: Math.round(e.getBoundingClientRect().left), right: Math.round(e.getBoundingClientRect().right), width: Math.round(e.getBoundingClientRect().width) } : null
    const toc = document.querySelector('aside, [data-toc], nav[aria-label]')
    return {
      tocPresent: !!document.querySelector('aside.ml-8, aside[class*="w-56"]'),
      tocRect: rect(toc), canvasRect: rect(canvas), wikiRect: rect(wiki),
      tocRightVsCanvasRight: toc && canvas ? Math.round(toc.getBoundingClientRect().right - canvas.getBoundingClientRect().right) : null,
      containerMaxWidth: container ? getComputedStyle(container).maxWidth : null,
      wikiMaxWidth: wiki ? getComputedStyle(wiki).maxWidth : null
    }
  })
  out.push({ width: w, ...r })
  console.log(`视口 ${w}px: 目录轨=${r.tocPresent} 轨右缘-内容区右缘=${r.tocRightVsCanvasRight} 容器max-width=${r.containerMaxWidth} 正文max-width=${r.wikiMaxWidth} 正文宽=${r.wikiRect?.width}`)
  await ctx.close()
}
await browser.close()
fs.writeFileSync(process.env.QA_OUT || "/tmp/ciki-qa258-prod/toc-breakpoint.json", JSON.stringify(out, null, 1))
