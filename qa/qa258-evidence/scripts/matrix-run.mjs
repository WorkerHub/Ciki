// QA258 主题矩阵 harness：同一脚本跑「合并前基线(4 套)」与「合并后(7 套)」，输出可逐字段比对的 JSON。
// 用法: node matrix.mjs <label> <style1,style2,...> [mode1,mode2,...]
import { chromium } from "playwright-core"
import fs from "node:fs"

const LABEL = process.argv[2] || "run"
const STYLES = (process.argv[3] || "nova,paper,natural,eink").split(",").filter(Boolean)
const MODES = (process.argv[4] || "light,dark").split(",").filter(Boolean)
const BASE = process.env.QA_BASE || "http://127.0.0.1:18899"
const EXEC = process.env.HOME + "/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell"
const TOKEN = process.env.QA_TOKEN || fs.readFileSync("/tmp/ciki-qa258/qa-session.env", "utf8").match(/TOKEN=(\S+)/)[1]
const PAGE_ID = process.env.QA_PAGE || "1"
const AUTHOR_ID = process.env.QA_AUTHOR || "2"
const MARKER = process.env.QA_MARKER || "QA258-COMMENT-MARKER"
const PROXY = process.env.QA_PROXY || ""
const HOST = new URL(BASE).hostname
const OUT = process.env.QA_OUT || `/tmp/ciki-qa258/${LABEL}.json`
const SHOTS = process.env.QA_SHOTS || `/tmp/ciki-qa258/shots`
fs.mkdirSync(SHOTS, { recursive: true })

const VAR_LIST = [
  "--background","--foreground","--card","--card-foreground","--popover","--popover-foreground",
  "--primary","--primary-foreground","--secondary","--secondary-foreground","--muted","--muted-foreground",
  "--accent","--accent-foreground","--destructive","--border","--input","--ring",
  "--chart-1","--chart-2","--chart-3","--chart-4","--chart-5",
  "--sidebar","--sidebar-foreground","--sidebar-primary","--sidebar-primary-foreground",
  "--sidebar-accent","--sidebar-accent-foreground","--sidebar-border","--sidebar-ring",
  "--radius","--radius-lg","--radius-md","--radius-sm","--radius-xl","--r-card","--r-ctl","--r-chip",
  "--shadow-card","--shadow-ctl","--shadow-pop","--grain","--grain-blend",
  "--code-bg","--code-fg","--code-dim","--code-kw","--code-str","--code-type","--code-border",
  "--wiki-font-size","--wiki-line-height","--wiki-max-width","--wiki-heading-1","--wiki-heading-2",
  "--wiki-font","--wiki-font-body","--wiki-font-heading","--code-font","--code-font-size"
]

// 页面通用探针：令牌 + 关键表面
function probeCommon(VAR_LIST) {
  const cs = getComputedStyle(document.documentElement)
  const vars = {}
  for (const v of VAR_LIST) vars[v] = cs.getPropertyValue(v).trim()
  const pick = (el, props) => {
    if (!el) return null
    const c = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = c.getPropertyValue(p)
    return o
  }
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => Array.from(document.querySelectorAll(sel))
  // 颜色 -> sRGB（canvas 转换，避免手写 oklch 换算误差）
  const cv = document.createElement("canvas")
  cv.width = cv.height = 1
  const cx = cv.getContext("2d", { willReadFrequently: true })
  const toRgb = (str) => {
    if (!str) return null
    const s = String(str).trim()
    if (s === "transparent" || s === "rgba(0, 0, 0, 0)") return [255, 255, 255]
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = "#000"
    cx.fillStyle = s
    cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
  const lum = (rgb) => {
    if (!rgb) return null
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
  }
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b)
    if (la === null || lb === null) return null
    const hi = Math.max(la, lb), lo = Math.min(la, lb)
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
  }
  const bodyBg = getComputedStyle(document.body).backgroundColor
  const btnDef = q('[data-slot="button"][data-variant="default"]')
  const btnOut = q('[data-slot="button"][data-variant="outline"]')
  const mutedEl = q('.text-muted-foreground')
  const meta = q('meta[name="theme-color"]')
  const surface = (sel) => pick(typeof sel === "string" ? q(sel) : sel, ["background-color","color","border-color","border-style","border-radius","box-shadow"])
  return {
    dataTheme: document.documentElement.getAttribute("data-theme"),
    dataMode: document.documentElement.getAttribute("data-mode"),
    darkClass: document.documentElement.classList.contains("dark"),
    metaColor: meta ? meta.getAttribute("content") : null,
    vars,
    body: pick(document.body, ["background-color","color","font-family","font-size"]),
    bodyBgRgb: toRgb(bodyBg),
    mainPanel: surface('[data-testid="main"]'),
    sidebarPanel: surface(Array.from(document.querySelectorAll('.bg-sidebar')).map((e) => [e, e.getBoundingClientRect()]).find(([, r]) => r.width >= 200)?.[0] || document.querySelector('[data-testid="sidebar"]')),
    btnDefault: pick(btnDef, ["background-color","color","border-radius","box-shadow","border-style","border-width"]),
    btnOutline: pick(btnOut, ["background-color","color","border-style","border-color","border-width","box-shadow"]),
    mutedText: pick(mutedEl, ["color"]),
    input: pick(q('input[type="text"], textarea, [data-slot="input"]'), ["background-color","border-color","color","border-radius"]),
    tableHead: pick(q("thead th, [data-slot='table-head']"), ["background-color","color","border-color"]),
    tableCell: pick(q("tbody td, [data-slot='table-cell']"), ["background-color","color","border-color"]),
    badge: pick(q('[data-slot="badge"]'), ["background-color","color","border-color"]),
    grain: (() => { const s = getComputedStyle(document.body, "::after"); return { opacity: s.opacity, mixBlendMode: s.mixBlendMode, bg: s.backgroundImage.slice(0, 100) } })(),
    contrast: {
      "primaryFgOnPrimary": ratio(toRgb(vars["--primary-foreground"]), toRgb(vars["--primary"])),
      "fgOnBg": ratio(toRgb(vars["--foreground"]), toRgb(vars["--background"])),
      "mutedFgOnBg": ratio(toRgb(vars["--muted-foreground"]), toRgb(vars["--background"])),
      "mutedFgOnCard": ratio(toRgb(vars["--muted-foreground"]), toRgb(vars["--card"])),
      "btnDefaultReal": btnDef ? ratio(toRgb(getComputedStyle(btnDef).color), toRgb(getComputedStyle(btnDef).backgroundColor)) : null,
      "mutedRealOnBody": mutedEl ? ratio(toRgb(getComputedStyle(mutedEl).color), toRgb(bodyBg)) : null
    },
    counts: {
      buttons: qa('[data-slot="button"]').length,
      toggleItems: qa('[data-slot="toggle-group-item"]').length,
      tables: qa("table").length
    }
  }
}

async function setAccountStyle(style) {
  const res = await fetch(`${BASE}/api/me/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: `ciki_session=${TOKEN}` },
    body: JSON.stringify({ themeStyle: style })
  })
  return { status: res.status }
}

async function newCtx(browser, mode, viewport, extra = {}) {
  const ctx = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    ...(PROXY ? { proxy: { server: PROXY, bypass: "127.0.0.1,localhost" } } : {}),
    ...extra
  })
  await ctx.addCookies([{ name: "ciki_session", value: TOKEN, domain: HOST, path: "/" }])
  await ctx.addInitScript((m) => {
    localStorage.setItem("ciki-theme", JSON.stringify({ state: { mode: m, style: "nova", migratedAt: 1, modeMigratedAt: 1 }, version: 0 }))
  }, mode)
  return ctx
}

async function goto(page, url, waitFor) {
  await page.goto(url, { waitUntil: "load", timeout: 90000 })
  // 生产链路慢：必须等真实组件挂载，不能只等 load 事件（否则取样到未渲染的壳）。
  // [data-testid="main"] 只在阅读/编辑壳里有，其余路由用「出现按钮」作为渲染完成信号。
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="button"]').length > 0, null, { timeout: 20000 }).catch(() => {})
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(400)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const out = { meta: { label: LABEL, base: BASE, styles: STYLES, modes: MODES, at: new Date().toISOString() }, entries: {} }

for (const style of STYLES) {
  const put = await setAccountStyle(style)
  for (const mode of MODES) {
    const key = `${style}-${mode}`
    const e = { putStatus: put.status }

    const ctx = await newCtx(browser, mode, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    await page.addInitScript((m) => { window.__QA_MARKER__ = m }, MARKER)

    // 1) 阅读页
    await goto(page, `${BASE}/p/${PAGE_ID}`, ".wiki-content")
    await page.waitForSelector('[data-html-embed-iframe]', { timeout: 10000 }).catch(() => {})
    e.read = await page.evaluate(probeCommon, VAR_LIST)
    e.read.wiki = await page.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      return {
        wikiContent: pick(q(".wiki-content"), ["max-width","font-size","line-height","color","font-family","margin-left","margin-right"]),
        readviewContainer: pick(q("[data-readview-container]"), ["max-width","margin-left","margin-right","padding-left","padding-right"]),
        wikiContainer: pick(q(".wiki-content")?.closest("div"), ["max-width","margin-left","margin-right"]),
        pageCanvas: pick(q("[data-page-canvas]"), ["max-width","margin-left","margin-right"]),
        link: pick(q(".wiki-content a"), ["color","text-decoration-line","font-weight"]),
        codeBlock: pick(q(".wiki-content .code-block"), ["background-color","color","border-color","border-radius","border-style"]),
        codePre: pick(q(".wiki-content .code-block > pre"), ["background-color","color","font-family"]),
        table: pick(q(".wiki-content table"), ["border-color","border-width","background-color"]),
        tableHead: pick(q(".wiki-content th"), ["background-color","border-color","color"]),
        tableCell: pick(q(".wiki-content td"), ["border-color"]),
        hr: pick(q(".wiki-content hr"), ["border-style","border-top-style","border-width","border-color"]),
        blockquote: pick(q(".wiki-content blockquote"), ["border-left-style","border-left-color","border-left-width","color"]),
        canvasImg: pick(q('img[data-type="excalidraw"]'), ["width","border-radius","border-style","border-color","background-color"]),
        canvasWrap: pick(q('img[data-type="excalidraw"]')?.closest("figure") || q('img[data-type="excalidraw"]')?.parentElement, ["background-color","border-color","border-radius","box-shadow","padding"]),
        embedBlock: pick(q('[data-type="html-embed"]'), ["background-color","border-color","border-radius","border-style","padding"]),
        embedIframe: pick(q('[data-html-embed-iframe]'), ["width","height","background-color","border-radius"]),
        embedFrameSrc: q('[data-html-embed-iframe]')?.getAttribute("src") || null
      }
    })
    e.read.toc = await page.evaluate(() => {
      const q = (s) => document.querySelector(s)
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top) } }
      const aside = Array.from(document.querySelectorAll("aside")).find((a) => a.querySelector("nav"))
      const nav = q("aside nav")
      const container = q("[data-readview-container]")
      const canvas = q("[data-page-canvas]")
      const wiki = q(".wiki-content")
      const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null)
      const cr = rect(canvas)
      const ar = rect(aside)
      const nr = rect(nav)
      return {
        tocPresent: !!aside,
        tocAriaLabel: nav ? nav.getAttribute("aria-label") : null,
        tocItems: document.querySelectorAll("aside nav a").length,
        asideRect: ar,
        navRect: nr,
        containerRect: rect(container),
        canvasRect: cr,
        wikiRect: rect(wiki),
        containerMaxWidth: cs(container, "max-width"),
        wikiMaxWidth: cs(wiki, "max-width"),
        wikiWidth: rect(wiki) ? rect(wiki).width : null,
        containerFlex: cs(container, "flex"),
        // 目录轨右边缘与内容区右边缘的差值（像素）：0 表示贴齐
        tocRightVsCanvasRight: ar && cr ? Math.round((ar.right - cr.right) * 100) / 100 : null,
        navRightVsCanvasRight: nr && cr ? Math.round((nr.right - cr.right) * 100) / 100 : null
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-read-${key}.png`, fullPage: false })

    // 2) 编辑页
    await goto(page, `${BASE}/p/${PAGE_ID}/edit`, ".ProseMirror")
    e.edit = await page.evaluate(probeCommon, VAR_LIST)
    e.edit.editor = await page.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      return {
        wikiContent: pick(q(".wiki-content"), ["max-width","font-size","line-height","font-family"]),
        proseMirror: pick(q(".ProseMirror"), ["max-width","font-size","line-height","background-color","color","font-family","padding"]),
        editorShell: pick(q('[data-slot="editor"]') || q(".wiki-content")?.parentElement, ["max-width","background-color","padding"]),
        toolbarBtn: pick(q('[data-slot="editor-toolbar"] button'), ["background-color","color","border-style","border-color","border-radius"]),
        codeBlock: pick(q(".wiki-content .code-block"), ["background-color","border-color","border-style","border-radius"]),
        embedBlock: pick(q('[data-type="html-embed"]'), ["background-color","border-color","border-style"])
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-edit-${key}.png` })

    // 3) 评论区（滚到底）
    await goto(page, `${BASE}/p/${PAGE_ID}`, ".wiki-content")
    await page.waitForSelector("[data-comment-id]", { timeout: 10000 }).catch(() => {})
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(900)
    e.comments = await page.evaluate(probeCommon, VAR_LIST)
    e.comments.area = await page.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      return {
        commentCount: document.querySelectorAll("[data-comment-id]").length,
        commentCard: pick(q("[data-comment-id]"), ["background-color","border-color","border-radius","border-style"]),
        commentText: pick(q("[data-comment-id] .text-sm"), ["color","font-size"]),
        composer: pick(q("textarea"), ["background-color","border-color","color","border-radius","border-style"]),
        submitBtn: pick(q('textarea ~ * button, [data-slot="button"][data-variant="default"]'), ["background-color","color"]),
        mention: (document.body.innerText || "").includes(window.__QA_MARKER__)
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-comments-${key}.png` })

    // 4) 通知面板（顶栏铃）+ 通知页
    await goto(page, `${BASE}/p/${PAGE_ID}`)
    // radix dropdown 只认真实指针事件，必须用 Playwright locator 点击（evaluate 合成 click 打不开面板）
    try {
      await page.locator('[data-slot="dropdown-menu-trigger"][aria-label="通知"]').click({ timeout: 5000 })
    } catch {
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find(x => (x.getAttribute("aria-label") || "") === "通知"); if (b) b.click() })
    }
    await page.waitForTimeout(1000)
    e.notificationsPanel = await page.evaluate(() => {
      const panels = Array.from(document.querySelectorAll('[data-slot="dropdown-menu-content"]'))
      const el = panels[panels.length - 1]
      if (!el) return null
      const c = getComputedStyle(el)
      const item = el.querySelector('[data-slot="dropdown-menu-item"]')
      const ic = item ? getComputedStyle(item) : null
      return {
        bg: c.backgroundColor, color: c.color, borderColor: c.borderColor, radius: c.borderRadius,
        itemBg: ic ? ic.backgroundColor : null, itemColor: ic ? ic.color : null,
        text: (el.textContent || "").trim().slice(0, 80)
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-notif-${key}.png` })
    await goto(page, `${BASE}/notifications`, '[data-testid="main"], main')
    e.notificationsPage = await page.evaluate(probeCommon, VAR_LIST)

    // 5) 作者主页
    await goto(page, `${BASE}/users/${AUTHOR_ID}`, "h1, h2")
    e.author = await page.evaluate(probeCommon, VAR_LIST)
    e.author.area = await page.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      return {
        name: pick(q("h1, h2"), ["color","font-size"]),
        bio: pick(q(".text-muted-foreground"), ["color"]),
        card: pick(q('[data-slot="card"]'), ["background-color","border-color","border-radius"]),
        avatar: pick(q('[data-slot="avatar"]'), ["background-color"]),
        hasMarker: (document.body.innerText || "").includes("QA258")
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-author-${key}.png` })

    // 6) 系统管理各页
    e.admin = {}
    for (const sub of ["users", "spaces", "site", "security", "email", "others"]) {
      await goto(page, `${BASE}/admin/${sub}`, '[data-testid="main"], main')
      const p = await page.evaluate(probeCommon, VAR_LIST)
      p.area = await page.evaluate(() => {
        const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
        const q = (s) => document.querySelector(s)
        return {
          heading: q("h1,h2")?.textContent?.trim().slice(0, 20) || null,
          tableContainer: pick(q('[data-slot="table-container"]'), ["background-color","border-color","border-radius"]),
          badge: pick(q('[data-slot="badge"]'), ["background-color","color"]),
          primaryBtn: pick(q('[data-slot="button"][data-variant="default"]'), ["background-color","color"]),
          switch: pick(q('[data-slot="switch"]'), ["background-color","border-color"])
        }
      })
      e.admin[sub] = p
    }
    await goto(page, `${BASE}/admin/users`)
    await page.screenshot({ path: `${SHOTS}/${LABEL}-admin-${key}.png` })

    // 7) 设置页（风格选项 + 保存按钮）
    await goto(page, `${BASE}/settings`, '[role="radiogroup"]')
    e.settings = await page.evaluate(probeCommon, VAR_LIST)
    e.settings.area = await page.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      const items = Array.from(document.querySelectorAll('[data-slot="toggle-group-item"]')).map((b) => ({
        text: (b.textContent || "").trim(), state: b.getAttribute("data-state"), checked: b.getAttribute("aria-checked")
      }))
      return {
        styleItems: items,
        styleItemCount: items.length,
        saveBtn: pick(q('[data-slot="button"][data-variant="default"]'), ["background-color","color","border-radius"]),
        modeCycleBtn: (() => {
          const b = Array.from(document.querySelectorAll("button")).find(x => (x.getAttribute("aria-label") || "").startsWith("主题"))
          return b ? { label: b.getAttribute("aria-label"), title: b.getAttribute("title") } : null
        })()
      }
    })
    await page.screenshot({ path: `${SHOTS}/${LABEL}-settings-${key}.png` })

    await ctx.close()

    // 8) 移动端壳
    const mctx = await newCtx(browser, mode, { width: 390, height: 844 }, { isMobile: true, hasTouch: true })
    const mpage = await mctx.newPage()
    await goto(mpage, `${BASE}/p/${PAGE_ID}`, ".wiki-content")
    e.mobile = await mpage.evaluate(probeCommon, VAR_LIST)
    e.mobile.shell = await mpage.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      const trig = q('[data-slot="sheet-trigger"]')
      return {
        hasSheetTrigger: !!trig,
        triggerLabel: trig?.getAttribute("aria-label") || null,
        body: pick(document.body, ["background-color"]),
        mainPanel: pick(q('[data-testid="main"]'), ["background-color"]),
        topbar: pick(q("header"), ["background-color","border-color"]),
        wiki: pick(q(".wiki-content"), ["max-width","font-size"])
      }
    })
    await mpage.screenshot({ path: `${SHOTS}/${LABEL}-mobile-${key}.png` })
    // 打开侧栏抽屉
    await mpage.evaluate(() => {
      const b = document.querySelector('[data-slot="sheet-trigger"]')
      if (b) b.click()
    })
    await mpage.waitForTimeout(900)
    e.mobile.sheet = await mpage.evaluate(() => {
      const pick = (el, props) => { if (!el) return null; const c = getComputedStyle(el); const o = {}; for (const p of props) o[p] = c.getPropertyValue(p); return o }
      const q = (s) => document.querySelector(s)
      const content = q('[data-slot="sheet-content"]')
      const overlay = q('[data-slot="sheet-overlay"]')
      return {
        open: !!content,
        content: pick(content, ["background-color","border-color","border-radius"]),
        overlayBg: overlay ? getComputedStyle(overlay).backgroundColor : null
      }
    })
    await mpage.screenshot({ path: `${SHOTS}/${LABEL}-mobile-sheet-${key}.png` })
    await mctx.close()

    out.entries[key] = e
    console.log(`${key}: theme=${e.read.dataTheme} mode=${e.read.dataMode} body=${e.read.body["background-color"]} meta=${e.read.metaColor} contrast=${JSON.stringify(e.read.contrast)}`)
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
  }
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log("saved", OUT)
await browser.close()
