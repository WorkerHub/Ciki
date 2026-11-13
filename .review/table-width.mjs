/**
 * 表格末列右边线拖拽自测（真 Chrome + 真构建产物）。
 *
 *   node table-width.mjs <repo>/web/dist [port] [outDir]
 *
 * ① 当前构建：编辑态量四张表 → 拖末列 → 量总宽/列宽/横滚 → 保存看 PUT 里的 colwidth
 *    → 进阅读态量同一宽度。
 * ② 同一份已保存的正文，注入旧规则（max-width: 100% !important）复现「末列拖不动」。
 * 所有数字都读 DOM 真实几何。
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = process.argv[2]
const PORT = Number(process.argv[3] || 8899)
const OUT = process.argv[4] || ""
const here = dirname(fileURLToPath(import.meta.url))
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (label) => console.log("[step]", label)

const mock = spawn(
  process.execPath,
  [join(here, "mock-server.mjs"), DIST, String(PORT)],
  { stdio: "ignore" }
)
await sleep(700)

const profile = mkdtempSync(join(tmpdir(), "ciki-table-width-"))
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,1000",
    "about:blank"
  ],
  { stdio: "ignore" }
)

let exitCode = 0
try {
  let port = 0
  for (let i = 0; i < 60; i += 1) {
    await sleep(200)
    try {
      port = Number(
        readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]
      )
      if (port) break
    } catch {
      /* 端口文件还没落地 */
    }
  }
  if (!port) throw new Error("Chrome 调试端口没起来")

  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()
  const ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl
  )
  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    // 编辑页有未保存改动时挂 beforeunload：CDP 导航会被原生对话框挡住，直接放行
    if (message.method === "Page.javascriptDialogOpening") {
      ws.send(
        JSON.stringify({
          id: ++seq,
          method: "Page.handleJavaScriptDialog",
          params: { accept: true }
        })
      )
      return
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  await new Promise((resolve) => {
    ws.onopen = resolve
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      seq += 1
      pending.set(seq, resolve)
      ws.send(JSON.stringify({ id: seq, method, params }))
    })
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (out.result?.exceptionDetails) {
      throw new Error(JSON.stringify(out.result.exceptionDetails).slice(0, 400))
    }
    return out.result?.result?.value
  }
  const mouse = (type, x, y) =>
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1
    })

  const MEASURE = (index) => `(() => {
    const t = document.querySelectorAll('.wiki-content .tableWrapper table')[${index}]
    const wrap = t.closest('.tableWrapper')
    const cells = [...t.querySelectorAll(':scope > tbody > tr:first-child > td')]
      .map((td) => Math.round(td.getBoundingClientRect().width * 10) / 10)
    const cols = [...t.querySelectorAll(':scope > colgroup > col')].map((c) => c.getAttribute('style'))
    return {
      tableW: Math.round(t.getBoundingClientRect().width * 10) / 10,
      tableStyle: t.getAttribute('style'),
      maxWidth: getComputedStyle(t).maxWidth,
      wrapClient: wrap.clientWidth,
      wrapScroll: wrap.scrollWidth,
      cells,
      cols
    }
  })()`

  async function waitForTables(count) {
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      const n = await evaluate(
        "document.querySelectorAll('.wiki-content .tableWrapper table').length"
      )
      if (n >= count) return
    }
    throw new Error("编辑器里的表格没渲染出来")
  }

  async function openEdit() {
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/p/1/edit` })
    await waitForTables(4)
  }

  /** 真实鼠标拖第 index 张表，colIndex 列的右边线（-1 = 末列）。 */
  async function dragEdge(index, colIndex, dx) {
    const geom = await evaluate(`(() => {
      const t = document.querySelectorAll('.wiki-content .tableWrapper table')[${index}]
      const cells = [...t.querySelectorAll(':scope > tbody > tr:first-child > td')]
      const target = cells[${colIndex} < 0 ? cells.length - 1 : colIndex].getBoundingClientRect()
      return { right: target.right, mid: (target.top + target.bottom) / 2 }
    })()`)
    const x = geom.right - 2
    const y = geom.mid
    await mouse("mouseMoved", x, y)
    await sleep(120)
    const hover = await evaluate(
      "({ resizeCursor: document.querySelector('.wiki-content').classList.contains('resize-cursor'), handles: document.querySelectorAll('.column-resize-handle').length })"
    )
    await mouse("mousePressed", x, y)
    await sleep(60)
    for (let i = 1; i <= 6; i += 1) {
      await mouse("mouseMoved", x + (dx * i) / 6, y)
      await sleep(40)
    }
    await mouse("mouseReleased", x + dx, y)
    await sleep(250)
    return hover
  }

  async function shot(name) {
    if (!OUT) return
    const out = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(join(OUT, name), Buffer.from(out.result.data, "base64"))
  }

  await send("Page.enable")
  await send("Runtime.enable")
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })

  const report = {}

  // ── 修后（当前构建）───────────────────────────────────────────────────
  await openEdit()
  step("edit opened")
  report.beforeA = await evaluate(MEASURE(0))
  report.hoverA = await dragEdge(0, -1, 120)
  report.afterA = await evaluate(MEASURE(0))
  await shot("after-edit.png")
  step("A dragged")

  report.beforeB = await evaluate(MEASURE(1))
  await dragEdge(1, -1, 120)
  report.afterB = await evaluate(MEASURE(1))
  step("B dragged")

  report.beforeC = await evaluate(MEASURE(2))
  await evaluate(`(() => {
    const t = document.querySelectorAll('.wiki-content .tableWrapper table')[2]
    const wrap = t.closest('.tableWrapper')
    wrap.scrollLeft = wrap.scrollWidth
    return wrap.scrollLeft
  })()`)
  await sleep(200)
  report.hoverC = await dragEdge(2, -1, 60)
  report.afterC = await evaluate(MEASURE(2))
  step("C dragged")

  report.beforeD = await evaluate(MEASURE(3))
  step("D measured")

  // 保存：点工具条上的保存按钮，读 mock 收到的 payload
  const saveRect = await evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-editor-sticky-bar] button')]
      .find((item) => item.textContent.trim() === '保存')
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!saveRect) throw new Error("没找到保存按钮")
  await mouse("mouseMoved", saveRect.x, saveRect.y)
  await mouse("mousePressed", saveRect.x, saveRect.y)
  await mouse("mouseReleased", saveRect.x, saveRect.y)
  await sleep(1000)
  step("saved")

  const payload = await (
    await fetch(`http://127.0.0.1:${PORT}/api/save-payload`)
  ).json()
  const savedJson = payload?.contentJson
    ? JSON.parse(payload.contentJson)
    : null
  const firstRowColwidths = (node) =>
    node?.type === "table"
      ? node.content[0].content.map((c) => c.attrs?.colwidth ?? null)
      : null
  report.savedColwidths = savedJson
    ? savedJson.content
        .filter((node) => node.type === "table")
        .map(firstRowColwidths)
    : null

  // 读态
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/p/1` })
  await waitForTables(4)
  report.readA = await evaluate(MEASURE(0))
  report.readB = await evaluate(MEASURE(1))
  report.readC = await evaluate(MEASURE(2))
  report.readD = await evaluate(MEASURE(3))
  await shot("after-read.png")
  step("read measured")

  // ── 修前对照：同一份正文 + 旧规则，复现「末列拖不动」───────────────────
  await openEdit()
  await evaluate(`(() => {
    const style = document.createElement('style')
    style.textContent = '.wiki-content .tableWrapper > table { max-width: 100% !important; }'
    document.head.appendChild(style)
    return true
  })()`)
  await sleep(200)
  report.baselineA = await evaluate(MEASURE(0))
  await dragEdge(0, -1, 120)
  report.baselineAAfterDrag = await evaluate(MEASURE(0))
  await shot("before-edit.png")
  step("baseline measured")

  console.log(JSON.stringify(report, null, 2))

  ws.close()
} catch (error) {
  console.error("FAILED:", error.message)
  exitCode = 1
} finally {
  chrome.kill()
  mock.kill()
}
process.exit(exitCode)
