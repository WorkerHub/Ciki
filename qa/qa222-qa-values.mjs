// QA #222 四象限抓值脚本：真实页面 computedStyle + 截图
// 用法: node qa-values.mjs <out-json> <shot-dir> [resumeMarker]
import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"

const BASE = "http://127.0.0.1:8788"
const OUT = process.argv[2]
const SHOTS = process.argv[3]
mkdirSync(SHOTS, { recursive: true })
const EMAIL = process.argv[4]
const PASSWORD = "ciki-test-2026"

// 抓取一页里所有关键元素的 computedStyle
const COLLECT = () => {
  const pick = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = cs.getPropertyValue(p)
    o._bgImage = cs.backgroundImage
    return o
  }
  const cp = ["background-color", "color", "border-top-color", "border-bottom-color"]
  const html = document.documentElement
  const out = {
    html: {
      dataTheme: html.getAttribute("data-theme"),
      dataMode: html.getAttribute("data-mode"),
      classes: html.className,
      styleAttr: html.getAttribute("style"),
      colorScheme: getComputedStyle(html).colorScheme
    },
    bodyBg: getComputedStyle(document.body).backgroundColor,
    inlineCode: pick(document.querySelector(".wiki-content :not(pre) > code"), cp),
    // 正文代码块（第一个）
    codeBlock: pick(document.querySelector(".wiki-content .code-block"), cp),
    codePre: pick(document.querySelector(".wiki-content .code-block > pre"), cp),
    codeHeader: pick(document.querySelector(".wiki-content .code-block [data-code-header], .wiki-content .code-block > button"), cp),
    codeLang: pick(document.querySelector(".wiki-content .code-block [data-code-language]"), cp),
    // 表格单元格内代码块
    tdCodeBlock: pick(document.querySelector(".wiki-content td .code-block"), cp),
    tdCodePre: pick(document.querySelector(".wiki-content td .code-block > pre"), cp),
    // 评论代码围栏（裸 pre）
    commentPre: pick(document.querySelector(".comment-body pre"), cp),
    commentPreCode: pick(document.querySelector(".comment-body pre > code"), cp),
    hljs: {}
  }
  const roles = {
    kw: ".wiki-content .hljs-keyword",
    kwTag: ".wiki-content .hljs-tag",
    selectorTag: ".wiki-content .hljs-selector-tag",
    str: ".wiki-content .hljs-string",
    regexp: ".wiki-content .hljs-regexp",
    type: ".wiki-content .hljs-type",
    classTitle: ".wiki-content .hljs-title.class_",
    builtIn: ".wiki-content .hljs-built_in",
    comment: ".wiki-content .hljs-comment",
    punctuation: ".wiki-content .hljs-punctuation",
    number: ".wiki-content .hljs-number",
    literal: ".wiki-content .hljs-literal",
    fn: ".wiki-content .hljs-title.function_",
    title: ".wiki-content .hljs-title",
    attr: ".wiki-content .hljs-attr",
    variable: ".wiki-content .hljs-variable",
    section: ".wiki-content .hljs-section"
  }
  for (const [k, sel] of Object.entries(roles)) {
    const el = document.querySelector(sel)
    out.hljs[k] = el ? getComputedStyle(el).color : null
  }
  // CSS 变量真值（在 html 上解析）
  const css = getComputedStyle(html)
  out.vars = {}
  for (const v of ["--code-bg", "--code-fg", "--code-dim", "--code-kw", "--code-str", "--code-type", "--code-border"]) {
    out.vars[v] = css.getPropertyValue(v).trim()
  }
  return out
}

const shot = async (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })
const page = await ctx.newPage()

// 1. UI 登录（真实路径）
await page.goto(`${BASE}/login`)
await page.locator('input[type="email"], input[name="email"]').fill(EMAIL)
await page.locator('input[type="password"], input[name="password"]').fill(PASSWORD)
await page.locator('button[type="submit"]').click()
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 })
console.log("login ok, url:", page.url())

// 2. 打开验收页
await page.goto(`${BASE}/p/1`)
await page.locator(".wiki-content .code-block").first().waitFor({ timeout: 15000 })
await page.waitForTimeout(600)

// 辅助：通过设置页切换主题风格（radio + 保存），回到阅读页
const setStyle = async (style) => {
  await page.goto(`${BASE}/settings`)
  const want = style === "paper" ? "纸面" : "Nova"
  const radio = page.getByRole("radio", { name: want })
  await radio.waitFor({ timeout: 10000 })
  const checked = await radio.getAttribute("aria-checked")
  console.log(`setStyle(${style}): radio[${want}] aria-checked=${checked}`)
  if (checked !== "true") {
    await radio.click()
    const save = page.locator("button[type='button']:has-text('保存')").first()
    try {
      await save.waitFor({ state: "visible", timeout: 3000 })
      await page.waitForFunction(
        () => {
          const btns = [...document.querySelectorAll("button[type='button']")]
          const b = btns.find((x) => x.textContent.includes("保存"))
          return b && !b.disabled
        },
        { timeout: 3000 }
      )
    } catch {
      const state = await page.evaluate(() => {
        const radios = [...document.querySelectorAll("[role='radio']")].map((r) => `${r.textContent}=${r.getAttribute("aria-checked")}`)
        const btns = [...document.querySelectorAll("button")].filter((x) => x.textContent.includes("保存")).map((b) => `${b.disabled ? "disabled" : "enabled"}@${b.getBoundingClientRect().top}`)
        return { radios, btns }
      })
      console.log("save button still disabled, state:", JSON.stringify(state))
      throw new Error(`setStyle(${style}): save button not enabled`)
    }
    await save.click()
    await page.waitForTimeout(700) // 等 PUT + store 更新
  } else {
    console.log(`setStyle(${style}): already active, skip save`)
  }
  await page.goto(`${BASE}/p/1`)
  await page.locator(".wiki-content .code-block").first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(400)
}

// 辅助：顶栏循环按钮切到目标亮暗（auto→light→dark 循环）
const setMode = async (target) => {
  for (let i = 0; i < 4; i++) {
    const cur = await page.evaluate(() => document.documentElement.getAttribute("data-mode"))
    if (cur === target) return
    await page.getByRole("button", { name: /主题：.+，点击切换/ }).click()
    await page.waitForTimeout(300)
  }
  throw new Error(`setMode(${target}) failed`)
}

const bgOf = (page) => page.evaluate(() => {
  const el = document.querySelector(".wiki-content .code-block")
  if (!el) return null
  return getComputedStyle(el).backgroundColor
})
const results = {}
const seq = []

// T1 paper + light
await setStyle("paper")
await setMode("light")
await page.goto(`${BASE}/p/1`)
await page.locator(".wiki-content .code-block").first().waitFor()
await page.waitForTimeout(500)
results["paper-light"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T1-paper-light-reading")
// 代码块特写
const cb = page.locator(".wiki-content .code-block").first()
await cb.scrollIntoViewIfNeeded()
await page.screenshot({ path: `${SHOTS}/T1-paper-light-codeblock.png` })

// 评论区域
const comment = page.locator(".comment-body pre").first()
if (await comment.count()) {
  await comment.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/T1-paper-light-comment.png` })
}
// 表格区域
const tbl = page.locator(".wiki-content td .code-block").first()
if (await tbl.count()) {
  await tbl.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/T1-paper-light-table.png` })
}

// 编辑器内代码块
await page.goto(`${BASE}/p/1/edit`)
await page.locator(".wiki-content .code-block").first().waitFor({ timeout: 15000 })
await page.waitForTimeout(800)
results["paper-light-editor"] = await page.evaluate(COLLECT)
await shot(page, "T1-paper-light-editor")

// T2 paper + dark
await page.goto(`${BASE}/p/1`)
await page.locator(".wiki-content .code-block").first().waitFor()
await setMode("dark")
await page.waitForTimeout(400)
results["paper-dark"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T2-paper-dark-reading")
const cb2 = page.locator(".wiki-content .code-block").first()
await cb2.scrollIntoViewIfNeeded()
await page.screenshot({ path: `${SHOTS}/T2-paper-dark-codeblock.png` })

// T3 nova + dark、nova + light
await setStyle("nova")
// 当前 dark，先抓 nova+dark
await page.goto(`${BASE}/p/1`)
await page.locator(".wiki-content .code-block").first().waitFor()
await page.waitForTimeout(400)
results["nova-dark"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T3-nova-dark-reading")
const cb3 = page.locator(".wiki-content .code-block").first()
await cb3.scrollIntoViewIfNeeded()
await page.screenshot({ path: `${SHOTS}/T3-nova-dark-codeblock.png` })

await setMode("light")
await page.waitForTimeout(400)
results["nova-light"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T3-nova-light-reading")
const cb4 = page.locator(".wiki-content .code-block").first()
await cb4.scrollIntoViewIfNeeded()
await page.screenshot({ path: `${SHOTS}/T3-nova-light-codeblock.png` })

// T5 残留序列：nova/light → paper/light → paper/dark → nova/dark → nova/light → paper/light
await setStyle("paper"); await setMode("light")
await page.goto(`${BASE}/p/1`); await page.locator(".wiki-content .code-block").first().waitFor(); await page.waitForTimeout(400)
results["seq-1-paper-light"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T5-seq1-paper-light")

await setMode("dark")
await page.waitForTimeout(400)
const curUrl = page.url()
const hasCb = await page.evaluate(() => Boolean(document.querySelector(".wiki-content .code-block")))
console.log("seq-2 debug:", curUrl, "hasCodeBlock:", hasCb)
results["seq-2-paper-dark"] = { url: curUrl, ...(await page.evaluate(COLLECT)) }
seq.push(await bgOf(page))

await setStyle("nova")
await page.waitForTimeout(300)
results["seq-3-nova-dark"] = { url: page.url(), ...(await page.evaluate(COLLECT)) }
seq.push(await bgOf(page))
await shot(page, "T5-seq3-nova-dark")

await setMode("light")
await page.waitForTimeout(400)
results["seq-4-nova-light"] = { url: page.url(), ...(await page.evaluate(COLLECT)) }
seq.push(await bgOf(page))

await setStyle("paper")
await page.waitForTimeout(300)
results["seq-5-paper-light-again"] = await page.evaluate(COLLECT)
seq.push(await bgOf(page))
await shot(page, "T5-seq5-paper-light-again")

// localStorage 主题镜像
results.localStorage = await page.evaluate(() => localStorage.getItem("ciki-theme"))

results.t5Sequence = seq
writeFileSync(OUT, JSON.stringify(results, null, 2))
console.log("results written to", OUT)
await browser.close()
