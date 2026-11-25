// #200 验收截图与量测脚本
// 用法: node shoot.mjs <状态标签> <输出目录>
//   状态标签 = fix（实现分支）或 base（main 基线）
import fs from "node:fs"
import { chromium } from "playwright"

const LABEL = process.argv[2] || "fix"
const OUT = process.argv[3] || `/tmp/qa-200/shots/${LABEL}`
fs.mkdirSync(OUT, { recursive: true })

const BASE = "http://localhost:9210"
const PAGE_URL = `${BASE}/p/1`

// 主题配置：localStorage["ciki-theme"]（zustand persist 格式）
const THEMES = {
  "nova-light": { theme: "light", style: "nova" },
  "paper-light": { theme: "light", style: "paper" },
  "paper-dark": { theme: "dark", style: "paper" },
}

// 视口矩阵
const VIEWPORTS = {
  wide: { width: 1920, height: 1080 },
  "narrow-1279": { width: 1279, height: 900 },
  "narrow-1024": { width: 1024, height: 800 },
}

// 量测脚本：在页面里收集几何与样式数据
const MEASURE = () => {
  const doc = document
  const root = doc.documentElement
  const pick = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: +(r.left + scrollX).toFixed(1),
      right: +(r.right + scrollX).toFixed(1),
      top: +(r.top + scrollY).toFixed(1),
      width: +r.width.toFixed(1),
      maxWidth: getComputedStyle(el).maxWidth,
      display: getComputedStyle(el).display,
    }
  }
  const container = doc.querySelector("[data-readview-container]")
  const aside = doc.querySelector("article aside")
  const nav = doc.querySelector('nav[aria-label*="目录"], nav[aria-label*="index"], nav[aria-label]')
  const canvas = doc.querySelector("[data-page-canvas]")
  const content = doc.querySelector(".wiki-content")
  const cs = content ? getComputedStyle(content) : null
  const bodyAfter = getComputedStyle(doc.body, "::after")
  const rootStyle = getComputedStyle(root)
  return {
    viewport: { w: root.clientWidth, h: root.clientHeight },
    devicePixelRatio: window.devicePixelRatio,
    htmlAttrs: {
      theme: root.getAttribute("data-theme"),
      dark: root.classList.contains("dark"),
      mode: root.getAttribute("data-mode"),
    },
    container: pick(container),
    tocAside: pick(aside),
    tocNav: pick(nav && aside && aside.contains(nav) ? nav : null),
    canvas: pick(canvas),
    content: cs
      ? {
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          fontFamily: cs.fontFamily.slice(0, 120),
          color: cs.color,
          width: +content.getBoundingClientRect().width.toFixed(1),
        }
      : null,
    paperTexture: root.getAttribute("data-theme") === "paper"
      ? {
          afterContent: bodyAfter.content,
          afterOpacity: bodyAfter.opacity,
          afterBackground: bodyAfter.backgroundImage.slice(0, 80),
          afterSize: bodyAfter.backgroundSize,
        }
      : null,
    readMaxWidthVar: rootStyle.getPropertyValue("--wiki-read-max-width") || null,
    bodyBg: getComputedStyle(doc.body).backgroundColor,
  }
}

const results = {}
const browser = await chromium.launch({ headless: true })

// 登录一次，存 storageState 供所有 context 复用
const STATE = "/tmp/qa-200/storage-state.json"
if (!fs.existsSync(STATE)) {
  const loginCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const lp = await loginCtx.newPage()
  await lp.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" })
  await lp.fill('input[type="email"]', "qa200@example.com")
  await lp.fill('input[type="password"]', "qa200-pass-1234")
  await lp.click('button[type="submit"]')
  await lp.waitForURL((u) => !String(u).includes("/login"), { timeout: 20000 })
  await lp.waitForTimeout(500)
  await loginCtx.storageState({ path: STATE })
  await loginCtx.close()
  console.log("logged in, storageState saved")
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  // 每个视口用独立 context（localStorage 互不串）
  for (const [themeName, cfg] of Object.entries(THEMES)) {
    // 窄视口只测 paper-light + nova-light（验收口径针对纸面）
    if (vpName !== "wide" && !(themeName === "paper-light" || themeName === "nova-light"))
      continue
    const context = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 1,
      storageState: STATE,
    })
    await context.addInitScript(
      (cfg) => {
        localStorage.setItem(
          "ciki-theme",
          JSON.stringify({ state: cfg, version: 0 })
        )
      },
      cfg
    )
    const page = await context.newPage()
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    // 等正文真正渲染完（ReadView 挂载、段落可见）
    await page.waitForSelector("[data-readview-container] .wiki-content p", {
      timeout: 15000,
    })
    await page.waitForTimeout(600) // 动画（motion 0.18s）与稳定余量
    const key = `${vpName}__${themeName}`
    results[key] = await page.evaluate(MEASURE)
    // 截图：首屏（视口内）与整页各一张
    await page.screenshot({ path: `${OUT}/${key}-viewport.png` })
    await page.screenshot({ path: `${OUT}/${key}-full.png`, fullPage: true })
    await context.close()
    console.log(`done: ${key}`)
  }
}

await browser.close()
fs.writeFileSync(`${OUT}/measurements.json`, JSON.stringify(results, null, 2))
console.log(`\nsaved to ${OUT}`)
