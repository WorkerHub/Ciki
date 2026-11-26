#!/usr/bin/env node
// Ciki 主题全矩阵 QA —— Playwright 生产真跑
// 4 风格 × 浅/暗 × 11 表面量测；切换矩阵；UI 保存；重登保留；Embed 探针；Nova/Paper 影子零漂移。
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { execSync } from "node:child_process"
import { randomBytes, createHash } from "node:crypto"
import { Api, luminance, contrast } from "./lib.mjs"

const BASE = "https://ciki.oneboy.app"
const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url)))
const shadowCss = readFileSync(new URL("./evidence/fa-shadow-baseline.css", import.meta.url), "utf8")
const expectedTokens = JSON.parse(readFileSync(new URL("./evidence/expected-tokens.json", import.meta.url), "utf8"))
const CHROME =
  process.env.HOME +
  "/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

mkdirSync(new URL("./evidence/shots/", import.meta.url), { recursive: true })

const results = []
let shotN = 0
function t(name, pass, detail) {
  results.push({ name, pass, detail: detail == null ? "" : String(detail) })
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail != null ? " — " + detail : ""}`)
}
async function shot(page, label) {
  shotN++
  const p = new URL(`./evidence/shots/${String(shotN).padStart(2, "0")}-${label}.png`, import.meta.url).pathname
  await page.screenshot({ path: p, fullPage: false })
  return p
}
const norm = (s) =>
  String(s ?? "")
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/gi, "#$1$1$2$2$3$3")
    // 所有数字统一规范化（百分数除以 100；toFixed(6) 消除浮点尾差）
    .replace(/(\d+(?:\.\d+)?)(%?)/g, (_, n, pc) => {
      let v = parseFloat(n)
      if (pc) v = v / 100
      return Number(v.toFixed(6)).toString()
    })
    // 裸小数补前导零（/.1 → /0.1）
    .replace(/(^|[^0-9])\.(\d)/g, "$10.$2")
    // 去全部空白（两侧同规则，只消除序列化差异）
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase()
function contrastOf(fgStr, bgStr) {
  // lib.contrast 直接接受色彩字符串（内部 parseColor）
  return contrast(fgStr, bgStr)
}

// ── API 会话（预置服务端风格） ─────────────────────────────────
const A = new Api("A")
A.cookies.set("ciki_session", state.cookies.A)
async function setServerStyle(style) {
  const r = await A.json("PUT", "/api/me/theme", { themeStyle: style })
  if (r.status !== 200) throw new Error(`setServerStyle(${style}) → ${r.status}`)
}

// ── 浏览器 ─────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" }
})

async function newSession(opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: Boolean(opts.mobile),
    hasTouch: Boolean(opts.mobile),
    serviceWorkers: "block",
    colorScheme: opts.colorScheme ?? "light"
  })
  await ctx.addCookies([
    {
      name: "ciki_session",
      value: opts.token ?? state.cookies.A,
      domain: "ciki.oneboy.app",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax"
    }
  ])
  if (opts.mode) {
    await ctx.addInitScript((m) => {
      localStorage.setItem(
        "ciki-theme",
        JSON.stringify({ state: { mode: m, style: "nova", migratedAt: null, modeMigratedAt: null }, version: 0 })
      )
    }, opts.mode)
  }
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200))
  })
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + String(err).slice(0, 200)))
  return { ctx, page, consoleErrors }
}

// ── 期望真值表 ─────────────────────────────────────────────────
// 探针（agent-guide §7 同源）body 与 chip 底/字色；k=v 为探针 CSS 原文
const PROBE_TRUTH = {
  light: {
    nova: { body: ["#ffffff", "oklch(0.145 0 0)"], chip: ["oklch(0.205 0 0)", "oklch(0.985 0 0)"] },
    paper: { body: ["#f7f4ee", "#2a2b2f"], chip: ["#e2705a", "#ffffff"] },
    natural: { body: ["#faf6f1", "#292524"], chip: ["#5f7050", "#ffffff"] },
    eink: { body: ["#f5f3ea", "#20211e"], chip: ["#20211e", "#f5f3ea"] }
  },
  dark: {
    nova: { body: ["oklch(0.145 0 0)", "oklch(0.985 0 0)"], chip: ["oklch(0.205 0 0)", "oklch(0.985 0 0)"] },
    paper: { body: ["#0b0c0e", "#f2f0eb"], chip: ["#e8694e", "#ffffff"] },
    natural: { body: ["#191612", "#ece7dd"], chip: ["#a3b18a", "#1c2317"] },
    eink: { body: ["#171814", "#eceade"], chip: ["#eceade", "#171814"] }
  }
}
const META = {
  nova: { light: "#ffffff", dark: "#0a0a0a" },
  paper: { light: "#f7f4ee", dark: "#0b0c0e" },
  natural: { light: "#faf6f1", dark: "#191612" },
  eink: { light: "#f5f3ea", dark: "#171814" }
}
// 页面内把期望值走一遍浏览器序列化再比对，规避色彩函数形式差异
const EXPECT_SERIALIZED = {} // style -> mode -> {body:[bg,fg],chip:[bg,fg]}（页内序列化后填）

// ── 页内量测函数 ───────────────────────────────────────────────
function measureEval() {
  return (probeTruth) => {
    const root = document.documentElement
    const gs = (el, p) => getComputedStyle(el).getPropertyValue(p).trim()
    const mk = (styles) => {
      const d = document.createElement("div")
      for (const [k, v] of Object.entries(styles)) d.style.setProperty(k, v)
      d.style.cssText += ";position:absolute;visibility:hidden"
      document.body.appendChild(d)
      return d
    }
    // 用 canvas 把任意 CSS 色解析成 sRGB 8bit（兼容 oklch/色函数），供对比度计算
    const toRgb256 = (cssColor) => {
      const c = document.createElement("canvas")
      c.width = c.height = 1
      const x = c.getContext("2d", { willReadFrequently: true })
      x.fillStyle = cssColor
      x.fillRect(0, 0, 1, 1)
      const d = x.getImageData(0, 0, 1, 1).data
      return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")"
    }
    const probe = (styles) => {
      const d = mk(styles)
      const cs = getComputedStyle(d)
      const out = { bg: cs.backgroundColor, fg: cs.color }
      out.bg256 = toRgb256(out.bg)
      out.fg256 = toRgb256(out.fg)
      d.remove()
      return out
    }
    const out = {
      url: location.href,
      html: {
        dataTheme: root.getAttribute("data-theme"),
        dataMode: root.getAttribute("data-mode"),
        dark: root.classList.contains("dark"),
        colorScheme: root.style.colorScheme
      },
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
      tokens: {},
      probes: {
        body: probe({ background: "var(--background)", color: "var(--foreground)" }),
        primary: probe({ background: "var(--primary)", color: "var(--primary-foreground)" }),
        muted: probe({ background: "var(--background)", color: "var(--muted-foreground)" })
      },
      els: {}
    }
    for (const tk of [
      "--background", "--foreground", "--card", "--card-foreground", "--popover", "--popover-foreground",
      "--primary", "--primary-foreground", "--secondary", "--secondary-foreground",
      "--muted", "--muted-foreground", "--accent", "--accent-foreground", "--border", "--input", "--ring"
    ])
      out.tokens[tk] = gs(root, tk)
    const pick = (sel, props) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const o = {}
      for (const p of props) o[p] = cs[p]
      return o
    }
    out.els.code = pick(".wiki-content pre", ["backgroundColor", "color"])
    out.els.codeInline = pick(".wiki-content code", ["backgroundColor", "color"])
    out.els.th = pick(".wiki-content th", ["backgroundColor", "color", "borderBottomColor"])
    out.els.td = pick(".wiki-content td", ["backgroundColor", "color"])
    out.els.blockquote = pick(".wiki-content blockquote", ["borderLeftColor", "color"])
    out.els.comment = pick("[data-comment-id]", ["backgroundColor", "color"])
    out.els.commentBody = pick("[data-comment-id] .wiki-content", ["backgroundColor", "color"])
    out.els.commentTime = pick("[data-comment-id] time", ["color"])
    out.els.prose = pick(".wiki-content", ["backgroundColor", "color"])
    out.els.header = pick("header", ["backgroundColor", "color", "borderBottomColor"])
    out.els.main = pick("main", ["backgroundColor", "color"])
    out.els.card = pick('[data-slot="card"]', ["backgroundColor", "color", "borderColor"])
    out.els.proseMirror = pick(".ProseMirror", ["backgroundColor", "color", "caretColor"])
    // 影子对照读数（若注入了影子样式则建探针 div）
    out.shadow = {}
    if (document.getElementById("qa-drift-shadow")) {
      for (const cls of ["qa-shadow-nova-light", "qa-shadow-nova-dark", "qa-shadow-paper-light", "qa-shadow-paper-dark"]) {
        const d = document.createElement("div")
        d.className = cls
        d.style.cssText = "position:absolute;visibility:hidden"
        document.body.appendChild(d)
        const cs = getComputedStyle(d)
        const o = {}
        for (const [k] of Object.entries(out.tokens)) o[k] = cs.getPropertyValue(k).trim()
        out.shadow[cls] = o
        d.remove()
      }
    }
    // 探针期望值页内序列化
    out.expectSerialized = probeTruth
      ? {
          body: probe({ background: probeTruth.body[0], color: probeTruth.body[1] }),
          chip: probe({ background: probeTruth.chip[0], color: probeTruth.chip[1] })
        }
      : null
    // localStorage
    out.themeLS = localStorage.getItem("ciki-theme")
    return out
  }
}

async function gotoSurf(page, path, opts = {}) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForSelector(opts.waitSel ?? "body", { timeout: 20000 })
  await page.waitForTimeout(opts.settle ?? 1100)
}

// 阅读页完整量测（含 embed 探针、canvas、代码、表格）
async function measureRead(page, style, mode, opts = {}) {
  await gotoSurf(page, `/p/${state.pageId}`, { waitSel: ".wiki-content h2", settle: 1400 })
  // 画布图与 embed iframe 需要进入视口才会 lazy 加载
  const embed = page.locator("iframe[data-html-embed-iframe]")
  try {
    await embed.scrollIntoViewIfNeeded({ timeout: 8000 })
  } catch {}
  await page.waitForTimeout(900)
  const m = await page.evaluate(measureEval(), PROBE_TRUTH[mode][style])
  // embed 探针状态
  let probe = null, embedSrc = null, embedBox = null
  try {
    embedSrc = await embed.getAttribute("src", { timeout: 4000 })
    const frame = page.frames().find((f) => f.url().includes("/api/files/"))
    if (frame) {
      await frame.waitForSelector("#chip", { timeout: 6000 })
      probe = await frame.evaluate(() => ({
        dataTheme: document.documentElement.getAttribute("data-theme"),
        dark: document.documentElement.classList.contains("dark"),
        urlLine: document.getElementById("url-line")?.textContent ?? "",
        msgLine: document.getElementById("msg-line")?.textContent ?? "",
        msgCount: document.getElementById("msg-count")?.textContent ?? "",
        body: (() => { const cs = getComputedStyle(document.body); return [cs.backgroundColor, cs.color] })(),
        chip: (() => { const c = document.getElementById("chip"); const cs = getComputedStyle(c); return [cs.backgroundColor, cs.color] })()
      }))
    }
    embedBox = await embed.boundingBox()
  } catch (e) {
    probe = { error: String(e).slice(0, 120) }
  }
  // 固定高度路径：iframe 内上报 420 不应改变 360
  let heightFixed = null
  try {
    const frame = page.frames().find((f) => f.url().includes("/api/files/"))
    if (frame && embedBox) {
      await frame.evaluate(() => window.parent.postMessage({ type: "ciki-embed-height", height: 420 }, "*"))
      await page.waitForTimeout(600)
      const after = await embed.boundingBox()
      heightFixed = { before: Math.round(embedBox.height), afterReport420: Math.round(after.height) }
    }
  } catch (e) {
    heightFixed = { error: String(e).slice(0, 120) }
  }
  return { ...m, embed: { src: embedSrc, probe, box: embedBox, heightFixed } }
}

// ── 断言辅助 ───────────────────────────────────────────────────
function assertTokens(name, m, style, mode) {
  if (style === "natural" || style === "eink") {
    const exp = expectedTokens[`${style}-${mode}`]
    const bad = []
    for (const [k, v] of Object.entries(exp)) {
      if (norm(m.tokens[k]) !== norm(v)) bad.push(`${k}: got=${m.tokens[k]} want=${v}`)
    }
    t(`${name} 令牌与规格一致`, bad.length === 0, bad.join("; ").slice(0, 300) || `17 项全对`)
  }
}
function assertContrast(name, m, style, mode, required) {
  // 用 256 量化后的 sRGB 值（兼容 oklch）
  const cPrim = contrastOf(m.probes.primary.fg256, m.probes.primary.bg256)
  const cBody = contrastOf(m.probes.body.fg256, m.probes.body.bg256)
  const cMut = contrastOf(m.probes.muted.fg256, m.probes.muted.bg256)
  const fmt = (c) => (c == null ? "n/a" : c.toFixed(2))
  const detail = `primary=${fmt(cPrim)} body=${fmt(cBody)} muted=${fmt(cMut)}`
  if (required) {
    const fails = []
    if (cPrim == null || cPrim < 4.5) fails.push(`primary ${fmt(cPrim)}`)
    if (cBody == null || cBody < 4.5) fails.push(`body ${fmt(cBody)}`)
    if (cMut == null || cMut < 4.5) fails.push(`muted ${fmt(cMut)}`)
    t(`${name} 三组对比度≥4.5`, fails.length === 0, `${detail}${fails.length ? " FAIL:" + fails.join(",") : ""}`)
  } else {
    t(`${name} 三组对比度记录`, cPrim != null && cBody != null && cMut != null, detail)
  }
}
function assertChrome(name, m, style, mode) {
  const dtOk = m.html.dataTheme === style
  const darkOk = mode === "dark" ? m.html.dark : !m.html.dark
  const modeOk = m.html.dataMode === mode
  const metaOk = norm(m.meta) === norm(META[style][mode])
  t(`${name} html[data-theme]/.dark/data-mode/meta`, dtOk && darkOk && modeOk && metaOk,
    `theme=${m.html.dataTheme} dark=${m.html.dark} mode=${m.html.dataMode} meta=${m.meta} want meta=${META[style][mode]}`)
}
function assertProbe(name, m, style, mode) {
  const p = m.embed?.probe
  if (!p || p.error) return t(`${name} embed 探针`, false, p?.error ?? "probe missing")
  const exp = m.expectSerialized
  const bodyOk = exp && norm(p.body[0]) === norm(exp.body.bg) && norm(p.body[1]) === norm(exp.body.fg)
  const chipOk = exp && norm(p.chip[0]) === norm(exp.chip.bg) && norm(p.chip[1]) === norm(exp.chip.fg)
  const attrOk = p.dataTheme === style && (mode === "dark") === p.dark
  const urlOk = /mode=(light|dark)&style=\w+/.test(m.embed.src ?? "") &&
    decodeURIComponent((m.embed.src.match(/mode=([^&]+)/) ?? [])[1] ?? "") === mode &&
    decodeURIComponent((m.embed.src.match(/style=([^&]+)/) ?? [])[1] ?? "") === style
  t(`${name} embed 属性/URL 参数/探针底字色/chip`, attrOk && urlOk && bodyOk && chipOk,
    `src=${m.embed.src} probeTheme=${p.dataTheme}/${p.dark ? "dark" : "light"} body=${p.body} chip=${p.chip}`)
  const h = m.embed.heightFixed
  t(`${name} embed 固定高度不受上报干扰`, h && h.before === 360 && h.afterReport420 === 360,
    h ? JSON.stringify(h) : "missing")
}
function assertDrift(name, m, style, mode) {
  const cls = `qa-shadow-${style}-${mode}`
  const sh = m.shadow[cls]
  if (!sh) return t(`${name} 影子零漂移`, false, "shadow probe missing")
  const bad = []
  for (const [k, v] of Object.entries(m.tokens)) {
    if (sh[k] !== undefined && norm(sh[k]) !== norm(v)) bad.push(`${k}: live=${v} shadow=${sh[k]}`)
  }
  t(`${name} 影子零漂移（fa3d679 vs 生产 computed）`, bad.length === 0, bad.join("; ").slice(0, 300) || "全部一致")
}

// ═══════════════════════════════════════════════════════════════
// Phase A：4 风格 × 浅/暗 全表面量测
// ═══════════════════════════════════════════════════════════════
const SURFACES = [
  { key: "edit", path: (s) => `/p/${state.pageId}/edit`, waitSel: ".ProseMirror" },
  { key: "notifications", path: () => `/notifications`, waitSel: "text=条未读" },
  { key: "author", path: () => `/users/${state.users.A.id}`, waitSel: "body" },
  { key: "settings", path: () => `/settings`, waitSel: 'button:text-is("自然")' },
  { key: "admin-users", path: () => `/admin/users`, waitSel: "body" },
  { key: "admin-spaces", path: () => `/admin/spaces`, waitSel: "body" },
  { key: "admin-site", path: () => `/admin/site`, waitSel: "body" },
  { key: "admin-security", path: () => `/admin/security`, waitSel: "body" },
  { key: "admin-email", path: () => `/admin/email`, waitSel: "body" },
  { key: "admin-others", path: () => `/admin/others`, waitSel: "body" }
]

for (const style of ["nova", "paper", "natural", "eink"]) {
  await setServerStyle(style)
  for (const mode of ["light", "dark"]) {
    const label = `${style}/${mode}`
    const { ctx, page, consoleErrors } = await newSession({ mode })
    // 阅读页（重点量测 + 截图 + embed + 零漂移影子）
    if (style === "nova" || style === "paper") {
      // 应用会清掉挂在 <html> 上的节点且 document-start 时 head 为 null，改在 DOMContentLoaded/load 时挂 head
      await page.addInitScript((css) => {
        const add = () => {
          if (document.getElementById("qa-drift-shadow")) return
          const s = document.createElement("style")
          s.id = "qa-drift-shadow"
          s.textContent = css
          ;(document.head || document.documentElement).appendChild(s)
        }
        document.addEventListener("DOMContentLoaded", add)
        window.addEventListener("load", add)
      }, shadowCss)
    }
    const m = await measureRead(page, style, mode)
    assertChrome(`read ${label}`, m, style, mode)
    assertTokens(`read ${label}`, m, style, mode)
    assertContrast(`read ${label}`, m, style, mode, style === "natural" || style === "eink")
    if (style === "nova" || style === "paper") assertDrift(`read ${label}`, m, style, mode)
    assertProbe(`read ${label}`, m, style, mode)
    // 画布/代码/表格/评论实际元素有读数
    t(`read ${label} 代码块有读数`, Boolean(m.els.code), m.els.code ? JSON.stringify(m.els.code) : "missing")
    t(`read ${label} 表格有读数`, Boolean(m.els.th && m.els.td), m.els.th ? JSON.stringify(m.els.th) : "missing")
    t(`read ${label} 画布预览存在`, await page.locator('img[src*="/api/files/pages/"]').count() > 0, "canvas img")
    t(`read ${label} 评论有读数`, Boolean(m.els.comment), m.els.comment ? JSON.stringify(m.els.comment) : "missing")
    await shot(page, `read-${style}-${mode}`)
    // 其余表面
    for (const surf of SURFACES) {
      try {
        await gotoSurf(page, surf.path(), { waitSel: surf.waitSel, settle: 1100 })
        let sm = await page.evaluate(measureEval(), null)
        // admin/作者页可能 chunk 加载慢导致首测时 applyTheme 未跑完，等 data-theme 到位后重测一次
        if (sm.html.dataTheme !== style) {
          await page.waitForFunction((s) => document.documentElement.getAttribute("data-theme") === s, style, { timeout: 8000 }).catch(() => {})
          await page.waitForTimeout(300)
          sm = await page.evaluate(measureEval(), null)
        }
        assertChrome(`${surf.key} ${label}`, sm, style, mode)
        assertContrast(`${surf.key} ${label}`, sm, style, mode, style === "natural" || style === "eink")
        if (surf.key === "edit") {
          // 编辑态渲染 embed 卡片（无 iframe，高度/替换/删除控件）
          const cardCount = await page.locator("[data-html-embed-card]").count()
          const iframeCount = await page.locator("iframe[data-html-embed-iframe]").count()
          t(`edit ${label} embed 卡片存在且无 iframe`, cardCount === 1 && iframeCount === 0, `card=${cardCount} iframe=${iframeCount}`)
          t(`edit ${label} ProseMirror 有读数`, Boolean(sm.els.proseMirror), sm.els.proseMirror ? JSON.stringify(sm.els.proseMirror) : "missing")
        }
        if (surf.key === "notifications") {
          const items = await page.locator('div.divide-y button:has-text("评论了文档")').count()
          t(`notifications ${label} 有通知卡片`, items >= 2, `items=${items}`)
          if (style === "natural" || style === "eink") await shot(page, `notif-${style}-${mode}`)
        }
        if (surf.key === "settings") {
          const opts = (await page.locator('[data-slot="card"] button').allTextContents()).map((x) => x.trim())
          const have = ["Nova", "纸面", "自然", "墨纸"].filter((x) => opts.includes(x))
          t(`settings ${label} 四风格选项可见`, have.length === 4, `have=${have.join("/")}`)
        }
        if (surf.key.startsWith("admin")) {
          const h1 = await page.locator("h1, h2").first().textContent().catch(() => "")
          t(`${surf.key} ${label} 页面加载`, Boolean(h1 && h1.trim()), `heading=${(h1 ?? "").trim().slice(0, 40)}`)
        }
      } catch (e) {
        t(`${surf.key} ${label} 加载`, false, String(e).slice(0, 160))
      }
    }
    const uniqErrs = [...new Set(consoleErrors)].filter((e) => !/favicon|sourcemap|Source map/i.test(e))
    t(`console ${label} 无主题相关报错`, !uniqErrs.some((e) => /theme|oklch|style/i.test(e)), uniqErrs.slice(0, 3).join(" | ") || "clean")
    await ctx.close()
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase B：模式切换矩阵（4 风格 × auto/light/dark 可达 + 刷新保持 + 系统跟随）
// ═══════════════════════════════════════════════════════════════
for (const style of ["nova", "paper", "natural", "eink"]) {
  await setServerStyle(style)
  { // 上下文1：colorScheme light，无存储 → auto=light
    const { ctx, page } = await newSession({ colorScheme: "light" })
    await gotoSurf(page, `/p/${state.pageId}`, { waitSel: ".wiki-content h2", settle: 1200 })
    const m0 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 初始 auto=light`, m0.html.dataMode === "light" && !m0.html.dark && m0.html.dataTheme === style,
      `mode=${m0.html.dataMode} theme=${m0.html.dataTheme} ls=${(m0.themeLS ?? "").slice(0, 80)}`)
    const btn = page.locator('button[aria-label^="主题："]')
    await btn.click() // auto → light
    const m1 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 点击1→light`, m1.html.dataMode === "light" && JSON.parse(m1.themeLS).state.mode === "light", `ls=${m1.themeLS}`)
    await btn.click() // light → dark
    const m2 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 点击2→dark`, m2.html.dataMode === "dark" && m2.html.dark && JSON.parse(m2.themeLS).state.mode === "dark", `ls=${m2.themeLS}`)
    // 刷新保持
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForSelector(".wiki-content h2", { timeout: 20000 })
    await page.waitForTimeout(1200)
    const m3 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 刷新后保持 dark`, m3.html.dataMode === "dark" && m3.html.dark, `mode=${m3.html.dataMode}`)
    await btn.click() // dark → auto（colorScheme light → light）
    const m4 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 点击3→auto(light 系统)`, m4.html.dataMode === "light" && JSON.parse(m4.themeLS).state.mode === "auto", `mode=${m4.html.dataMode}`)
    await ctx.close()
  }
  { // 上下文2：colorScheme dark，无存储 → auto=dark
    const { ctx, page } = await newSession({ colorScheme: "dark" })
    await gotoSurf(page, `/p/${state.pageId}`, { waitSel: ".wiki-content h2", settle: 1200 })
    const m0 = await page.evaluate(measureEval(), null)
    t(`switch ${style} auto+系统暗=dark`, m0.html.dataMode === "dark" && m0.html.dark && m0.html.dataTheme === style, `mode=${m0.html.dataMode}`)
    const btn = page.locator('button[aria-label^="主题："]')
    await btn.click() // auto → light
    const m1 = await page.evaluate(measureEval(), null)
    t(`switch ${style} 系统暗下切 light`, m1.html.dataMode === "light" && !m1.html.dark, `mode=${m1.html.dataMode}`)
    await ctx.close()
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase C：设置页 UI 保存风格（natural、eink）+ 立即生效 + 服务端落库
// ═══════════════════════════════════════════════════════════════
for (const style of ["natural", "eink"]) {
  await setServerStyle("nova")
  const { ctx, page } = await newSession({ mode: "light" })
  await gotoSurf(page, "/settings", { settle: 1400 })
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator(`button:text-is("${style === "natural" ? "自然" : "墨纸"}")`) })
    .first()
  await card.locator(`button:text-is("${style === "natural" ? "自然" : "墨纸"}")`).click()
  await card.locator('button:text-is("保存")').click()
  await page.waitForSelector("text=主题风格已保存", { timeout: 8000 })
  await page.waitForTimeout(400)
  const m = await page.evaluate(measureEval(), null)
  const api = await A.json("GET", "/api/me")
  t(`ui-save ${style} html 立即生效`, m.html.dataTheme === style, `theme=${m.html.dataTheme}`)
  t(`ui-save ${style} 服务端落库`, api.data?.themeStyle === style, `api=${api.data?.themeStyle}`)
  // 刷新保持
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector("body", { timeout: 20000 })
  await page.waitForTimeout(1500)
  const m2 = await page.evaluate(measureEval(), null)
  t(`ui-save ${style} 刷新后保持`, m2.html.dataTheme === style, `theme=${m2.html.dataTheme}`)
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════
// Phase D：natural / eink 重登保留（新铸会话）
// ═══════════════════════════════════════════════════════════════
function wrangler(sql) {
  const quoted = "'" + sql.replace(/'/g, "'\\''") + "'"
  const out = execSync(`npx --yes wrangler d1 execute ciki --remote --json --command ${quoted}`, {
    cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024
  }).toString()
  return JSON.parse(out.slice(out.indexOf("[")))[0].results
}
function mintSession(userId) {
  const token = randomBytes(32).toString("base64url")
  const hash = createHash("sha256").update(token).digest("hex")
  const sid = randomBytes(8).toString("hex") + "-qa"
  const tsec = Math.floor(Date.now() / 1000)
  wrangler(`INSERT INTO sessions (id, token_hash, user_id, needs_2fa_setup, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES ('${sid}', '${hash}', ${userId}, 0, ${tsec}, ${tsec}, ${tsec + 3600}, 'qa', 'ciki-theme-qa')`)
  return token
}
for (const style of ["natural", "eink"]) {
  await setServerStyle(style)
  const token2 = mintSession(state.users.A.id)
  const { ctx, page } = await newSession({ token: token2 })
  await gotoSurf(page, `/p/${state.pageId}`, { waitSel: ".wiki-content h2", settle: 1300 })
  const m = await page.evaluate(measureEval(), null)
  t(`relogin ${style} 新会话保留`, m.html.dataTheme === style, `theme=${m.html.dataTheme}`)
  await ctx.close()
}

// ═══════════════════════════════════════════════════════════════
// Phase E：移动端壳（4 风格 × 浅/暗 阅读页）
// ═══════════════════════════════════════════════════════════════
for (const style of ["nova", "paper", "natural", "eink"]) {
  await setServerStyle(style)
  for (const mode of ["light", "dark"]) {
    const { ctx, page } = await newSession({ mode, mobile: true })
    await gotoSurf(page, `/p/${state.pageId}`, { waitSel: ".wiki-content h2", settle: 1300 })
    const m = await page.evaluate(measureEval(), null)
    assertChrome(`mobile ${style}/${mode}`, m, style, mode)
    const burger = page.locator('header button[aria-label*="菜单"], header button[aria-label*="导航"], [data-slot="sheet"] button, header button').first()
    const burgerVisible = await burger.isVisible().catch(() => false)
    t(`mobile ${style}/${mode} 顶栏可交互`, burgerVisible, "topbar button visible")
    assertContrast(`mobile ${style}/${mode}`, m, style, mode, style === "natural" || style === "eink")
    if ((style === "natural" && mode === "light") || (style === "eink" && mode === "dark")) await shot(page, `mobile-${style}-${mode}`)
    await ctx.close()
  }
}

await browser.close()

writeFileSync(new URL("./evidence/matrix-results.json", import.meta.url), JSON.stringify(results, null, 1))
const fail = results.filter((r) => !r.pass)
console.log(`\nMATRIX: ${results.length - fail.length}/${results.length} passed, shots=${shotN}`)
if (fail.length) {
  console.log("FAILURES:")
  for (const f of fail) console.log(" -", f.name, "::", f.detail.slice(0, 200))
  process.exit(1)
}
