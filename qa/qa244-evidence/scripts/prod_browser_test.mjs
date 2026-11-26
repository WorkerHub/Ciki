/**
 * QA244 — 生产真跑：验证「插入 HTML」图标已由 Code2 改为 AppWindow（#242 / PR #292）。
 *
 * 被测对象：https://ciki.pama.workers.dev（Worker 名 ciki，APP_VERSION=v1.0.0-306-ecb2780）
 * 验收口径：
 *   1) 工具条：代码块（</>）与插入 HTML（AppWindow）一眼可区分；
 *   2) 点插入 HTML 仍走 .html 文件选择与插入流程，插入后占位卡显示 AppWindow，
 *      阅读态渲染与高度自适应行为符合既有协议；
 *   3) 代码块按钮行为不变。
 *
 * 运行：node prod_browser_test.mjs   （需要同目录 node_modules 指向 playwright-core）
 * 产物：shots/*.png、metrics/prod-metrics.json、results.json
 */
import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright-core"

const EXEC =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const HERE = path.dirname(new URL(import.meta.url).pathname)
const EVIDENCE = path.resolve(HERE, "..")
const SHOTS = path.join(EVIDENCE, "shots")
const METRICS = path.join(EVIDENCE, "metrics")
const KEYS_FILE = path.join(METRICS, "qa244-embed-keys.json")
const state = JSON.parse(fs.readFileSync("/tmp/qa244-state.json", "utf8"))
const BASE = state.base
const PAGE_ID = String(state.pageId)
const HOST = new URL(BASE).host

const LABEL_EMBED = "插入 HTML 动画"
const LABEL_CODE = "代码块"

const results = []
const consoleErrors = []
const failedRequests = []
const httpLog = []

function record(id, check, expected, actual, pass, note = "") {
  results.push({ id, check, expected, actual, pass, note })
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${check} | expected=${expected} | actual=${actual}${note ? ` | ${note}` : ""}`)
}

async function shot(file, locator) {
  const target = path.join(SHOTS, file)
  await locator.screenshot({ path: target })
  return target
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.mkdirSync(METRICS, { recursive: true })

  const sampleHtml = path.join(METRICS, "qa244-sample.html")
  fs.writeFileSync(
    sampleHtml,
    `<!doctype html>
<html><head><meta charset="utf-8"><title>QA244 sample</title>
<style>body{font-family:system-ui;margin:0;padding:24px;background:#f7f4ee;color:#222} .box{height:180px;background:linear-gradient(90deg,#f0b27a,#7fa8d8)}</style>
</head><body><h1>QA244 embed sample</h1><div class="box"></div><p>QA244-EMBED-MARKER</p></body></html>`
  )

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXEC,
    proxy: { server: "http://127.0.0.1:7890", bypass: "127.0.0.1,localhost" },
  })
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  await context.addCookies([
    {
      name: "ciki_session",
      value: state.sessionToken,
      domain: HOST,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ])
  // 捕获父页收到的 postMessage（阅读态高度上报协议 ciki-embed-height 的真实证据）
  await context.addInitScript(() => {
    window.__qa244Messages = []
    window.addEventListener("message", (event) => {
      try {
        if (event.data && typeof event.data === "object" && event.data.type === "ciki-embed-height") {
          window.__qa244Messages.push({ type: event.data.type, height: event.data.height })
        }
      } catch {}
    })
  })
  const page = await context.newPage()
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text())
  })
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
  page.on("response", (r) => httpLog.push({ method: r.request().method(), url: r.url(), status: r.status() }))

  const metrics = { base: BASE, pageId: PAGE_ID, host: HOST }

  // ---- 0. 生产版本自证 ------------------------------------------------------
  const versionRes = await page.request.get(`${BASE}/api/public`)
  metrics.version = (await versionRes.json()).version
  record("0.1", "生产 /api/public 版本串", "v1.0.0-306-ecb2780（含 ecb2780 = PR #292 合并提交）", metrics.version, metrics.version === "v1.0.0-306-ecb2780")

  // ---- 1. 打开编辑器，核对工具条两枚图标 -------------------------------------
  await page.goto(`${BASE}/p/${PAGE_ID}/edit`, { waitUntil: "domcontentloaded" })
  await page.locator('[role="toolbar"]').waitFor({ state: "visible", timeout: 45000 })
  await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 45000 })
  await page.waitForTimeout(800)

  const embedBtn = page.getByRole("button", { name: LABEL_EMBED })
  const codeBtn = page.getByRole("button", { name: LABEL_CODE })
  await embedBtn.waitFor({ state: "visible", timeout: 15000 })
  await codeBtn.waitFor({ state: "visible", timeout: 15000 })

  const iconInfo = async (loc) =>
    loc.locator("svg").evaluate((el) => ({
      class: el.getAttribute("class"),
      inner: el.innerHTML.replace(/\s+/g, " ").slice(0, 400),
      box: (() => {
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }
      })(),
    }))

  const embedIcon = await iconInfo(embedBtn)
  const codeIcon = await iconInfo(codeBtn)
  const embedBBox = await embedBtn.boundingBox()
  const codeBBox = await codeBtn.boundingBox()
  metrics.toolbar = { embed: embedIcon, code: codeIcon, embedBBox, codeBBox }

  record(
    "1.1",
    `工具栏「${LABEL_EMBED}」按钮图标类名`,
    "lucide-app-window（且不含 lucide-code-2）",
    embedIcon.class,
    /lucide-app-window/.test(embedIcon.class) && !/lucide-code-2/.test(embedIcon.class)
  )
  record(
    "1.2",
    `工具栏「${LABEL_CODE}」按钮图标类名`,
    "lucide-code-2（且不含 lucide-app-window）",
    codeIcon.class,
    /lucide-code-2/.test(codeIcon.class) && !/lucide-app-window/.test(codeIcon.class)
  )
  record(
    "1.3",
    "两个按钮的 SVG 图形数据不同（一眼可区分的客观依据）",
    "两段 innerHTML 不相等",
    embedIcon.inner === codeIcon.inner ? "相同" : "不同",
    embedIcon.inner !== codeIcon.inner,
    `embed=<rect x="2" y="4" …>（窗口+标题栏） / code=<path d="m18 16 4-4-4-4"…>（尖括号）`
  )
  const dividerBtn = page.getByRole("button", { name: "分割线" })
  const quoteBtn = page.getByRole("button", { name: "引用" })
  const dividerBBox = (await dividerBtn.count()) ? await dividerBtn.boundingBox() : null
  const quoteBBox = (await quoteBtn.count()) ? await quoteBtn.boundingBox() : null
  metrics.toolbar.dividerBBox = dividerBBox
  metrics.toolbar.quoteBBox = quoteBBox
  const iconSmMatch = dividerBBox && Math.abs(embedBBox.width - dividerBBox.width) < 1 && Math.abs(embedBBox.height - dividerBBox.height) < 1
  const smMatch = quoteBBox && Math.abs(codeBBox.width - quoteBBox.width) < 1 && Math.abs(codeBBox.height - quoteBBox.height) < 1
  record(
    "1.4",
    "两按钮几何保持既有壳规格（embed=icon-sm 壳、code=sm 壳，未因换图标改变）",
    "插入HTML按钮≈插入分割线按钮（icon-sm），代码块按钮≈引用按钮（sm）",
    `embed=${Math.round(embedBBox.width)}×${Math.round(embedBBox.height)} divider=${dividerBBox ? Math.round(dividerBBox.width) + "×" + Math.round(dividerBBox.height) : "n/a"} / code=${Math.round(codeBBox.width)}×${Math.round(codeBBox.height)} quote=${quoteBBox ? Math.round(quoteBBox.width) + "×" + Math.round(quoteBBox.height) : "n/a"}`,
    !!iconSmMatch && !!smMatch,
    "两种壳（icon-sm 28×28、sm 34×28）在工具条中本就混用，尺寸差异为既有设计，非本次改动引入"
  )

  await shot("prod-01-toolbar.png", page.locator('[role="toolbar"]'))
  await shot("prod-02-icon-htmlembed.png", embedBtn)
  await shot("prod-03-icon-codeblock.png", codeBtn)

  // ---- 2. 代码块按钮行为不变（先点正文建立选区） ------------------------------
  await page.locator(".ProseMirror p").first().click()
  await page.waitForTimeout(300)
  const codeBefore = await page.locator(".ProseMirror pre").count()
  await codeBtn.click()
  await page.locator(".ProseMirror pre").first().waitFor({ state: "visible", timeout: 10000 })
  await page.waitForTimeout(400)
  const codeAfter = await page.locator(".ProseMirror pre").count()
  const codeBlockView = await page.locator("[data-code-block]").count()
  const codeIconAfter = await iconInfo(codeBtn)
  metrics.codeBlock = { before: codeBefore, after: codeAfter, viewCount: codeBlockView, icon: codeIconAfter }
  record("3.1", "点击「代码块」后编辑器内出现代码块", "pre 数量 0 → 1", `${codeBefore} → ${codeAfter}`, codeAfter === codeBefore + 1)
  record("3.2", "代码块视图渲染（data-code-block）", "≥1", String(codeBlockView), codeBlockView >= 1)
  record("3.3", "点击后代码块按钮仍为 Code2 图标", "lucide-code-2", codeIconAfter.class, /lucide-code-2/.test(codeIconAfter.class) && !/lucide-app-window/.test(codeIconAfter.class))
  await shot("prod-04-codeblock-inserted.png", page.locator(".ProseMirror"))

  // ---- 3. 插入 HTML：文件选择 → 上传 → 占位卡 --------------------------------
  const fileInputInfo = await page.evaluate(() => {
    const input = document.querySelector('input[type="file"][accept=".html,text/html"]')
    return input ? { accept: input.getAttribute("accept"), type: input.type } : null
  })
  metrics.fileInput = fileInputInfo
  record("2.1", "工具条内隐藏的文件选择框 accept 属性", ".html,text/html", fileInputInfo?.accept, fileInputInfo?.accept === ".html,text/html")

  let chooser = null
  try {
    ;[chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10000 }),
      embedBtn.click(),
    ])
  } catch (err) {
    record("2.2", "点击「插入 HTML 动画」触发文件选择器", "触发 filechooser 事件", `未触发：${err.message}`, false)
  }
  if (chooser) {
    const chooserAccept = await chooser.element().evaluate((el) => el.getAttribute("accept"))
    record("2.2", "点击「插入 HTML 动画」触发文件选择器", "触发 filechooser 事件，input accept=.html,text/html", `已触发，accept=${chooserAccept}`, chooserAccept === ".html,text/html")
    await chooser.setFiles(sampleHtml)
  }

  const card = page.locator("[data-html-embed-card]")
  let cardVisible = true
  try {
    await card.waitFor({ state: "visible", timeout: 45000 })
  } catch {
    cardVisible = false
  }
  record("2.3", "选择 .html 文件后插入的占位卡出现", "编辑器内出现 [data-html-embed-card]", cardVisible ? "已出现" : "未出现", cardVisible)

  const uploadReq = httpLog.filter((r) => r.url.includes("/api/files/embeds"))
  metrics.embedUpload = uploadReq
  record("2.4", "占位卡插入走 embed 上传接口", "POST /api/files/embeds 返回 201", JSON.stringify(uploadReq), uploadReq.some((r) => r.status === 201))

  if (cardVisible) {
    const cardIcon = await card.locator("svg").first().evaluate((el) => ({
      class: el.getAttribute("class"),
      inner: el.innerHTML.replace(/\s+/g, " ").slice(0, 300),
    }))
    const nameText = (await page.locator("[data-html-embed-name]").first().textContent()) ?? ""
    metrics.embedCard = { icon: cardIcon, nameText }
    record("2.5", "占位卡身份图标类名", "lucide-app-window（且不含 lucide-code-2）", cardIcon.class, /lucide-app-window/.test(cardIcon.class) && !/lucide-code-2/.test(cardIcon.class))
    record("2.6", "占位卡显示文件名", "qa244-sample.html", nameText.trim(), nameText.includes("qa244-sample.html"))
    await shot("prod-05-embed-card.png", card)
  }

  // ---- 4. 保存 → 阅读态渲染与高度 -------------------------------------------
  await page.getByRole("button", { name: "保存" }).first().click()
  await page.waitForURL(/\/p\/\d+$/, { timeout: 45000 })
  const iframe = page.locator("[data-html-embed-iframe]")
  await iframe.waitFor({ state: "visible", timeout: 45000 })
  await page.waitForTimeout(3000) // 等高度上报消息与最终布局

  const src = await iframe.getAttribute("src")
  const iframeBox = await iframe.boundingBox()
  const messages = await page.evaluate(() => window.__qa244Messages ?? [])
  metrics.reading = { src, iframeBox, messages }

  // 4a. iframe src 内容核对（同源地址，父页受 sandbox 限制不可读内容文档，属安全设计）
  const srcUrl = new URL(src ?? "", BASE).toString()
  const srcRes = await page.request.get(srcUrl)
  const srcBody = await srcRes.text()
  const cspHeader = srcRes.headers()["content-security-policy"] ?? ""
  metrics.reading.srcCheck = {
    status: srcRes.status(),
    contentType: srcRes.headers()["content-type"] ?? "",
    len: srcBody.length,
    hasMarker: srcBody.includes("QA244-EMBED-MARKER"),
    hasReporter: srcBody.includes("ciki-embed-height"),
    cspHeader,
  }
  record(
    "2.7",
    "阅读态 iframe 内容真实渲染（src 可取且含原文件标记与高度上报脚本）",
    "GET src=200 text/html，含 QA244-EMBED-MARKER 与 ciki-embed-height，CSP=sandbox allow-scripts",
    JSON.stringify(metrics.reading.srcCheck),
    srcRes.status() === 200 &&
      /text\/html/.test(metrics.reading.srcCheck.contentType) &&
      metrics.reading.srcCheck.hasMarker &&
      metrics.reading.srcCheck.hasReporter &&
      /sandbox allow-scripts/.test(cspHeader)
  )
  record(
    "2.7b",
    "iframe 内脚本执行并上报高度（postMessage 到父页）",
    "父页收到 ≥1 条 ciki-embed-height 消息",
    `收到 ${messages.length} 条`,
    messages.length >= 1,
    JSON.stringify(messages.slice(0, 3))
  )
  await shot("prod-06-reading-iframe.png", iframe)
  await shot("prod-07-reading-page.png", page.locator("body"))

  // 4b. 高度自适应：iframe 渲染高度 == 内容上报高度（协议既有行为，与改前一致）
  const lastHeight = messages.length ? messages[messages.length - 1].height : null
  const gap = iframeBox && lastHeight != null ? Math.abs(iframeBox.height - lastHeight) : null
  metrics.reading.heightCheck = { iframeBoxHeight: iframeBox?.height, lastReported: lastHeight, gap }
  record(
    "2.8",
    "高度自适应：iframe 渲染高度 == 嵌入内容上报高度",
    "差值 <1px 且 >0",
    `iframe=${iframeBox?.height}px 上报=${lastHeight}px`,
    gap != null && gap < 1 && (iframeBox?.height ?? 0) > 0
  )

  // ---- 5. 记录本次新增 embed key（供终局精确清理） ---------------------------
  const newKey = src?.startsWith("/api/files/") ? src.replace("/api/files/", "").split("?")[0] : null
  metrics.newEmbedKey = newKey
  const keys = new Set(JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")))
  if (newKey) keys.add(newKey)
  fs.writeFileSync(KEYS_FILE, JSON.stringify([...keys].sort(), null, 2))
  console.log("本次新增 embed key:", newKey, "累计待清理:", [...keys].sort())

  // ---- 结果落盘 -------------------------------------------------------------
  fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({ results, consoleErrors, failedRequests, metrics }, null, 2))
  fs.writeFileSync(path.join(METRICS, "prod-metrics.json"), JSON.stringify(metrics, null, 2))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n== ${results.length - failed.length}/${results.length} 项通过 ==`)
  if (failed.length) console.log("失败项:", failed.map((f) => f.id).join(", "))
  console.log("console errors:", consoleErrors.length, "failed requests:", failedRequests.length)

  await browser.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error("FATAL", err)
  try {
    fs.writeFileSync(path.join(EVIDENCE, "results.json"), JSON.stringify({ results, consoleErrors, failedRequests, fatal: String(err) }, null, 2))
  } catch {}
  process.exit(2)
})
