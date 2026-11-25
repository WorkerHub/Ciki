// qa-200 重拍：修正主题存储字段（theme=auto/light/dark, style=nova/paper）
// 产物直接覆盖 shots/<branch>/ 下的 4 个无效文件
// 用法: node shoot-extra2.mjs fix|base
import fs from "node:fs"
import { chromium } from "playwright"

const BR = process.argv[2] || "fix"
const BASE = "http://localhost:9210"
const shotsDir = `/tmp/qa-200/shots/${BR}`
fs.mkdirSync(shotsDir, { recursive: true })
const storageState = JSON.parse(fs.readFileSync("/tmp/qa-200/storage-state.json", "utf8"))

// 函数形式 addInitScript，arg 注入正确格式的主题存储
const withTheme = (theme, style) => async (ctx) => {
  await ctx.addInitScript(
    (v) => {
      try {
        localStorage.setItem("ciki-theme", JSON.stringify({ state: v, version: 0 }))
      } catch (e) {}
    },
    { theme, style }
  )
}

const browser = await chromium.launch()

// ---- 1) 读页 2400 超宽：paper-light / nova-light ----
for (const [name, theme, style] of [
  ["wide2400__paper-light", "light", "paper"],
  ["wide2400__nova-light", "light", "nova"]
]) {
  const ctx = await browser.newContext({
    viewport: { width: 2400, height: 1200 },
    deviceScaleFactor: 1,
    storageState,
    reducedMotion: "reduce"
  })
  await withTheme(theme, style)(ctx)
  const page = await ctx.newPage()
  await page.goto(`${BASE}/p/1`, { waitUntil: "load", timeout: 30000 })
  await page.waitForSelector("[data-readview-container]", { timeout: 20000 })
  await page.waitForTimeout(500)
  const m = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        left: +b.left.toFixed(1),
        right: +b.right.toFixed(1),
        width: +b.width.toFixed(1),
        top: +b.top.toFixed(1)
      }
    }
    const container = document.querySelector("[data-readview-container]")
    const nav = document.querySelector("article aside nav")
    return {
      canvas: rect(document.querySelector("[data-page-canvas]")),
      container: { ...rect(container), maxWidth: container ? getComputedStyle(container).maxWidth : null },
      aside: rect(document.querySelector("article aside")),
      asideNav: rect(nav),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlAttrs: {
        dataTheme: document.documentElement.getAttribute("data-theme"),
        dataMode: document.documentElement.getAttribute("data-mode"),
        cls: document.documentElement.className
      }
    }
  })
  fs.writeFileSync(`${shotsDir}/${name}-measurements.json`, JSON.stringify(m, null, 2))
  await page.screenshot({ path: `${shotsDir}/${name}-viewport.png` })
  await ctx.close()
  console.log(`${BR} ${name} ok  bg=${m.bodyBg} dataTheme=${m.htmlAttrs.dataTheme}`)
}

// ---- 2) 编辑态 1920：paper-light（点击首段固定工具条标签）----
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    storageState,
    reducedMotion: "reduce"
  })
  await withTheme("light", "paper")(ctx)
  const page = await ctx.newPage()
  await page.goto(`${BASE}/p/1/edit`, { waitUntil: "load", timeout: 30000 })
  await page.waitForSelector("[data-editor-sticky-bar]", { timeout: 20000 })
  await page.waitForSelector(".ProseMirror p", { timeout: 30000 })
  await page.waitForTimeout(600)
  // 点击正文首段，把工具条标签稳定到「正文」
  await page.locator(".ProseMirror p").first().click()
  await page.waitForTimeout(400)
  const em = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { left: +b.left.toFixed(1), right: +b.right.toFixed(1), width: +b.width.toFixed(1) }
    }
    const bar = document.querySelector("[data-editor-sticky-bar]")
    const btns = bar ? [...bar.querySelectorAll("button")] : []
    return {
      editor: rect(document.querySelector(".ProseMirror")),
      surface: rect(bar ? bar.parentElement : null),
      title: rect(document.querySelector("input[name='page-title']")),
      toolbarLabel: btns[0] ? (btns[0].textContent || "").trim() : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlAttrs: {
        dataTheme: document.documentElement.getAttribute("data-theme"),
        dataMode: document.documentElement.getAttribute("data-mode")
      }
    }
  })
  fs.writeFileSync(`${shotsDir}/edit1920__paper-light-measurements.json`, JSON.stringify(em, null, 2))
  await page.screenshot({ path: `${shotsDir}/edit1920__paper-light-viewport.png` })
  await ctx.close()
  console.log(`${BR} edit1920 ok  label=${em.toolbarLabel} bg=${em.bodyBg} dataTheme=${em.htmlAttrs.dataTheme}`)
}

await browser.close()
console.log(`${BR} extra-v2 done`)
