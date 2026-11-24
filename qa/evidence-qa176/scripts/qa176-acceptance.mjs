/**
 * QA #176 验收真跑：评论框聚焦环左右不截断（基线/修复版同口径双跑）
 *
 * 用法: node qa176-acceptance.mjs <port> <tag>   例: node qa176-acceptance.mjs 8905 base
 * 前置: seed.sh 已建数（jim 登录态、页面 1、顶层评论 1 + 回复 2）
 * 证据: /tmp/qa176/evidence-<tag>/
 *
 * 判定口径：
 *  A. 聚焦环像素级: textarea 左/右外侧 6px 条带在「聚焦 vs 未聚焦」两态逐字节比较，
 *     不同=环被画出（可见），相同=环被裁剪（缺陷）。发表框另拍「未聚焦→聚焦→未聚焦」
 *     三连验证截图确定性（首尾两拍必须全等）。
 *  B. 几何: textarea/canvas rect、overflowClipMargin、borderColor、boxShadow。
 *  C. 对齐: h1/评论区 Separator/评论标题/发表框 左右缘一致（回复框/编辑框缩进属设计内，只记录）。
 *  D. 横滚阻截: 视口与内滚动容器均无横向滚动、宽表格(.tableWrapper)与代码块(pre)各自内部滚动。
 *  E. 预览切换: composer 容器 rect 不跳动、无横滚。
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const port = process.argv[2] ?? "8905"
const tag = process.argv[3] ?? "base"
const BASE = `http://127.0.0.1:${port}`
const EV = `/tmp/qa176/evidence-${tag}`
fs.mkdirSync(EV, { recursive: true })

const results = []
const consoleErrors = []
let shotIdx = 0

function record(id, name, pass, detail, extra = {}) {
  results.push({ id, name, verdict: pass ? "通过" : "不通过", detail, ...extra })
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${name} :: ${detail}`)
}

async function shot(page, label) {
  shotIdx += 1
  const file = path.join(EV, `${String(shotIdx).padStart(2, "0")}-${label}.png`)
  await page.screenshot({ path: file })
  return file
}

async function loginState(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  })
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`)
  const setCookie = res.headers.get("set-cookie") ?? ""
  const m = /ciki_session=([^;]+)/.exec(setCookie)
  if (!m) throw new Error(`no ciki_session cookie for ${email}`)
  return {
    cookies: [
      {
        name: "ciki_session",
        value: m[1],
        domain: "127.0.0.1",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        httpOnly: true,
        secure: false,
        sameSite: "Lax"
      }
    ],
    origins: []
  }
}

/* ---------- 页面内量测助手（全部 evaluate，不碰被测代码） ---------- */

function structureInfo() {
  const canvas = document.querySelector("[data-page-canvas]")
  const cs = canvas ? getComputedStyle(canvas) : null
  const ta = document.querySelector('textarea[data-slot="textarea"]')
  const h1 = document.querySelector("h1")
  const sep = document.querySelector('section[aria-labelledby="comments-heading"] [data-slot="separator"]')
  const heading = document.querySelector("#comments-heading")
  const composerBox = document.querySelector("[data-comment-composer]")
  const scroller = (() => {
    let el = canvas?.parentElement
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if (oy === "auto" || oy === "scroll") return el
      el = el.parentElement
    }
    return null
  })()
  const r = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { left: +b.left.toFixed(2), right: +b.right.toFixed(2), top: +b.top.toFixed(2), width: +b.width.toFixed(2) }
  }
  return {
    overflowX: cs?.overflowX,
    overflowClipMargin: cs?.overflowClipMargin,
    canvas: r(canvas),
    textarea: ta ? r(ta) : null,
    taBoxShadow: ta ? getComputedStyle(ta).boxShadow : null,
    taBorderColor: ta ? getComputedStyle(ta).borderTopColor : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    h1: r(h1),
    separator: r(sep),
    commentsHeading: r(heading),
    composerBox: r(composerBox),
    scroller: scroller
      ? { scrollW: scroller.scrollWidth, clientW: scroller.clientWidth, noH: scroller.scrollWidth <= scroller.clientWidth }
      : null,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }
}

async function openComposerArea(page) {
  await page.evaluate(() => {
    const el = document.querySelector("#comments-heading")
    if (el) el.scrollIntoView({ block: "start" })
  })
  await page.waitForSelector("textarea[data-slot=textarea]", { timeout: 15000 })
  await page.waitForTimeout(400)
}

async function focusTop(page) {
  await openComposerArea(page)
  const ta = page.locator('textarea[data-slot="textarea"]')
  await ta.click()
  await page.waitForTimeout(350)
}

/** 当前首个 composer（含 textarea）的作用域定位 */
function activeComposer(page) {
  return page.locator('[data-comment-composer]:has(textarea[data-slot="textarea"])').first()
}

/** 取 textarea 左/右外侧 6px 条带（高度取中部 8px），返回 png buffer */
async function strips(page, yMode = "mid") {
  const rect = await page.evaluate(() => {
    const ta = document.querySelector('textarea[data-slot="textarea"]')
    const b = ta.getBoundingClientRect()
    return { l: b.left, r: b.right, top: b.top, h: b.height }
  })
  const y = yMode === "mid" ? rect.top + rect.h / 2 - 4 : rect.top + 16
  const left = await page.screenshot({ clip: { x: Math.max(0, rect.l - 6), y, width: 6, height: 8 } })
  const right = await page.screenshot({ clip: { x: rect.r, y, width: 6, height: 8 } })
  return { left, right, rect }
}

async function setFocus(page, focused) {
  await page.evaluate((f) => {
    const ta = document.querySelector('textarea[data-slot="textarea"]')
    if (!ta) return
    if (f) ta.focus()
    else ta.blur()
  }, focused)
  await page.waitForTimeout(300)
}

/* ---------- 主流程 ---------- */
const browser = await chromium.launch()
try {
  const jimState = await loginState("jim@example.com", "JimPass123!")

  const trackConsole = (ctx, tg) => {
    ctx.on("page", (p) => {
      p.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push({ tag: tg, text: msg.text() })
      })
      p.on("pageerror", (err) => consoleErrors.push({ tag: tg, text: String(err) }))
    })
  }

  const VIEWPORTS = [
    { key: "m375", width: 375, height: 812, mobile: true },
    { key: "m390", width: 390, height: 844, mobile: true },
    { key: "desk", width: 1440, height: 900, mobile: false }
  ]
  const THEMES = ["light", "dark"]

  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      if (theme === "dark" && vp.key === "m375") continue
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        ...(vp.mobile ? { isMobile: true, hasTouch: true } : {}),
        storageState: {
          cookies: jimState.cookies,
          origins: [{ origin: BASE, localStorage: [{ name: "ciki-theme", value: theme }] }]
        }
      })
      trackConsole(ctx, `${vp.key}-${theme}`)
      const page = await ctx.newPage()
      const T = `${vp.key}-${theme}`

      await page.goto(`${BASE}/p/1`, { waitUntil: "domcontentloaded" })
      await page.locator("h1", { hasText: "聚焦环验收页" }).waitFor({ timeout: 20000 })
      await page.waitForTimeout(800)

      // 首屏截图（标题/正文/代码块/宽表格）
      await shot(page, `${T}-viewport-top`)

      // ===== D. 横滚阻截 =====
      const overflowInfo = await page.evaluate(structureInfo)
      const preInfo = await page.evaluate(() => {
        const pre = document.querySelector(".wiki-content pre")
        const tblWrap = document.querySelector(".wiki-content .tableWrapper")
        const pick = (el) =>
          el
            ? {
                scrollW: el.scrollWidth,
                clientW: el.clientWidth,
                overflows: el.scrollWidth > el.clientWidth,
                overflowX: getComputedStyle(el).overflowX
              }
            : null
        return { pre: pick(pre), table: pick(tblWrap) }
      })
      const pageOk =
        overflowInfo.docScrollWidth <= overflowInfo.innerWidth &&
        (overflowInfo.scroller?.noH ?? true)
      record(
        `D1-${T}`, "页面无异常横向滚动（视口/内滚动容器）",
        pageOk,
        `docScrollWidth=${overflowInfo.docScrollWidth}/${overflowInfo.innerWidth} scroller=${JSON.stringify(overflowInfo.scroller)}`,
        { ...overflowInfo, ...preInfo }
      )
      record(
        `D2-${T}`, "宽表格/代码块各自容器内横滚（阻截仍保留）",
        Boolean(preInfo.pre?.overflows) && Boolean(preInfo.table?.overflows),
        `pre ${preInfo.pre?.scrollW}/${preInfo.pre?.clientW} ox=${preInfo.pre?.overflowX}; table ${preInfo.table?.scrollW}/${preInfo.table?.clientW} ox=${preInfo.table?.overflowX}`,
        preInfo
      )

      // ===== ② 发表框未聚焦态: 无环属正常 =====
      await openComposerArea(page)
      const unfocused = await page.evaluate(structureInfo)
      await setFocus(page, false)
      const stripU = await strips(page)
      await shot(page, `${T}-top-composer-unfocused`)
      record(
        `A0-${T}`, "发表框未聚焦态无环（正常，不判缺陷）",
        unfocused.taBoxShadow === "none",
        `bodyBg=${unfocused.bodyBg} boxShadow=${unfocused.taBoxShadow} borderColor=${unfocused.taBorderColor}`,
        { structure: unfocused }
      )

      // ===== ① 发表框聚焦: 环左右完整 =====
      await setFocus(page, true)
      const focused = await page.evaluate(structureInfo)
      const stripF = await strips(page)
      await shot(page, `${T}-top-composer-focused`)
      await setFocus(page, false)
      const stripU2 = await strips(page)

      const leftRingVisible = !stripU.left.equals(stripF.left)
      const rightRingVisible = !stripU.right.equals(stripF.right)
      const deterministic = stripU.left.equals(stripU2.left) && stripU.right.equals(stripU2.right)

      fs.writeFileSync(path.join(EV, `${T}-strip-left-unfocused.png`), stripU.left)
      fs.writeFileSync(path.join(EV, `${T}-strip-left-focused.png`), stripF.left)
      fs.writeFileSync(path.join(EV, `${T}-strip-right-unfocused.png`), stripU.right)
      fs.writeFileSync(path.join(EV, `${T}-strip-right-focused.png`), stripF.right)

      record(
        `A1-${T}`, "发表框聚焦: 左侧环画出（聚焦/未聚焦条带像素不同）",
        leftRingVisible,
        `leftRingVisible=${leftRingVisible} deterministic=${deterministic}`,
        { leftRingVisible, deterministic }
      )
      record(
        `A2-${T}`, "发表框聚焦: 右侧环画出",
        rightRingVisible,
        `rightRingVisible=${rightRingVisible} deterministic=${deterministic}`,
        { rightRingVisible, deterministic }
      )
      record(
        `A3-${T}`, "发表框聚焦环完整（左右均画出 + 截图确定性成立）",
        leftRingVisible && rightRingVisible && deterministic,
        `overflowClipMargin=${unfocused.overflowClipMargin} boxShadow=${focused.taBoxShadow} ta.left=${focused.textarea?.left} canvas.left=${focused.canvas?.left} ta.right=${focused.textarea?.right} canvas.right=${focused.canvas?.right}`,
        { focused, strip: { leftRingVisible, rightRingVisible, deterministic } }
      )

      // ===== C. 对齐量测（h1 为内容自适应宽度，右缘不作参照）=====
      const ali = focused
      const tol = 0.6
      const alignOk =
        ali.h1 && ali.textarea && ali.separator &&
        Math.abs(ali.h1.left - ali.textarea.left) <= tol &&
        Math.abs(ali.separator.left - ali.textarea.left) <= tol &&
        Math.abs(ali.separator.right - ali.textarea.right) <= tol
      record(
        `C1-${T}`, "对齐: 发表框左缘=正文标题/分割线左缘、右缘=分割线右缘",
        alignOk,
        `bodyBg=${ali.bodyBg} h1.left=${ali.h1?.left} sep L/R=${ali.separator?.left}/${ali.separator?.right} ta L/R=${ali.textarea?.left}/${ali.textarea?.right}`,
        { align: ali }
      )
      await shot(page, `${T}-alignment-comments-top`)

      // ===== B1. 回复框（评论下的「回复」，autoFocus 即聚焦）=====
      const replyBtn = page.locator('button:has-text("回复")').first()
      await replyBtn.scrollIntoViewIfNeeded()
      await replyBtn.click()
      await page.waitForTimeout(500)
      let replyInfo = await page.evaluate(structureInfo)
      await shot(page, `${T}-reply-composer-autofocused`)
      await setFocus(page, true)  // 确保聚焦（autoFocus 本应已聚焦，双保险）
      const replyStripF = await strips(page, "top")
      await setFocus(page, false)
      const replyStripU = await strips(page, "top")
      const replyL = !replyStripU.left.equals(replyStripF.left)
      const replyR = !replyStripU.right.equals(replyStripF.right)
      record(
        `B1-${T}`, "回复框聚焦: 左右环画出",
        replyL && replyR,
        `replyL=${replyL} replyR=${replyR} clipMargin=${replyInfo.overflowClipMargin} ta.left=${replyInfo.textarea?.left} ta.right=${replyInfo.textarea?.right} (左缘应比发表框缩进≈17px)`,
        { reply: replyInfo, strip: { replyL, replyR } }
      )
      // 关闭回复框: 作用域到「当前含 textarea 的第一个 composer」
      await activeComposer(page).getByRole("button", { name: "取消" }).click()
      await page.waitForTimeout(400)

      // ===== B2. 编辑框（顶层评论的「编辑」，autoFocus 即聚焦）=====
      const editBtn = page.locator('button:has-text("编辑")').first()
      await editBtn.scrollIntoViewIfNeeded()
      await editBtn.click()
      await page.waitForTimeout(500)
      const editInfo = await page.evaluate(structureInfo)
      await shot(page, `${T}-edit-composer-autofocused`)
      await setFocus(page, true)
      const editStripF = await strips(page, "top")
      await setFocus(page, false)
      const editStripU = await strips(page, "top")
      const editL = !editStripU.left.equals(editStripF.left)
      const editR = !editStripU.right.equals(editStripF.right)
      record(
        `B2-${T}`, "编辑框聚焦: 左右环画出",
        editL && editR,
        `editL=${editL} editR=${editR} clipMargin=${editInfo.overflowClipMargin} ta.left=${editInfo.textarea?.left} ta.right=${editInfo.textarea?.right} (右缘应与发表框同、左缘缩进≈45px)`,
        { edit: editInfo, strip: { editL, editR } }
      )
      fs.writeFileSync(path.join(EV, `${T}-strip-reply-left-focus.png`), replyStripF.left)
      fs.writeFileSync(path.join(EV, `${T}-strip-reply-right-focus.png`), replyStripF.right)
      fs.writeFileSync(path.join(EV, `${T}-strip-edit-left-focus.png`), editStripF.left)
      fs.writeFileSync(path.join(EV, `${T}-strip-edit-right-focus.png`), editStripF.right)
      await activeComposer(page).getByRole("button", { name: "取消" }).click()
      await page.waitForTimeout(400)

      // ===== ⑤ 预览切换无布局跳动 =====
      await openComposerArea(page)
      const ta = page.locator('textarea[data-slot="textarea"]')
      await ta.fill("预览切换布局验证草稿文本。")
      await page.waitForTimeout(200)
      const beforeBox = await page.evaluate(structureInfo)
      const previewBtn = page.locator('[data-comment-composer] button:has-text("预览")').first()
      await previewBtn.click()
      await page.waitForTimeout(700)
      const afterBox = await page.evaluate(structureInfo)
      await shot(page, `${T}-preview-open`)
      const noJump =
        Math.abs((afterBox.composerBox?.left ?? 0) - (beforeBox.composerBox?.left ?? 0)) <= 0.6 &&
        Math.abs((afterBox.canvas?.width ?? 0) - (beforeBox.canvas?.width ?? 0)) <= 0.6 &&
        afterBox.docScrollWidth <= afterBox.innerWidth &&
        (afterBox.scroller?.noH ?? true)
      record(
        `E1-${T}`, "预览切换无布局跳动（容器左缘/canvas 宽不变、无横滚）",
        noJump,
        `composer.left ${beforeBox.composerBox?.left} -> ${afterBox.composerBox?.left}; canvas.width ${beforeBox.canvas?.width} -> ${afterBox.canvas?.width}; docScrollWidth=${afterBox.docScrollWidth}/${afterBox.innerWidth}`,
        { before: beforeBox, after: afterBox }
      )
      await page.locator('[data-comment-composer] button:has-text("预览")').first().click()
      await page.waitForTimeout(400)
      const restoreBox = await page.evaluate(structureInfo)
      record(
        `E2-${T}`, "收起预览回到输入态: composer 容器位置复原",
        Math.abs((restoreBox.composerBox?.left ?? 0) - (beforeBox.composerBox?.left ?? 0)) <= 0.6,
        `composer.left restored=${restoreBox.composerBox?.left} baseline=${beforeBox.composerBox?.left}`,
        { restore: restoreBox }
      )

      await ctx.close()
    }
  }

  const passCount = results.filter((r) => r.verdict === "通过").length
  const summary = {
    tag,
    port,
    results,
    passCount,
    total: results.length,
    consoleErrors
  }
  fs.writeFileSync(path.join(EV, "results.json"), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(EV, "console.json"), JSON.stringify(consoleErrors, null, 2))
  console.log(`\n=== ${tag}: ${passCount}/${results.length} 通过; console 错误 ${consoleErrors.length} 条 ===`)
} finally {
  await browser.close()
}
