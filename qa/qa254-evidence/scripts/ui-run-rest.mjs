/**
 * QA254 生产 UI 跑批·续（前段 39 项已过，因 APIRequestContext 直连 RST 中断）
 * 本段：口径4 接口负例（4c）→ 口径3d B 清空（丙）→ 终态 A 空态。
 * 代理通过 newContext({ proxy }) 注入：页面与 APIRequestContext 同走本地代理。
 */
import { chromium } from "playwright-core"
import { execFileSync } from "node:child_process"
import fs from "node:fs"

const BASE = "https://ciki.oneboy.app"
const CHROME =
  "/Users/mapan/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const EV = "/tmp/qa254/evidence"

for (const k of ["A_SESSION", "B_SESSION"]) {
  if (!process.env[k]) throw new Error(`missing env ${k}`)
}
const state = {}
for (const line of fs.readFileSync("/tmp/qa254/state.env", "utf8").split("\n")) {
  const m = line.match(/^export (\w+)=(\S+)$/)
  if (m) state[m[1]] = m[2]
}
const P = (n) => state[`P${n}_ID`]

const newResults = []
const newMetrics = []
function rec(id, criterion, expect, actual, ok) {
  newResults.push({ id, criterion, expect, actual: String(actual), ok: !!ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${expect}  ⇒  ${actual}`)
  if (!ok) process.exitCode = 1
}
async function shot(page, name) {
  await page.screenshot({ path: `${EV}/shots/${name}`, fullPage: true })
}
function d1(sql) {
  const out = execFileSync("/tmp/qa254/scripts/d1q.sh", [sql], { encoding: "utf8" })
  const parsed = JSON.parse(out)
  if (!parsed.success) throw new Error("D1 failed: " + JSON.stringify(parsed.errors))
  return parsed.result[0].results
}

const zh = {
  title: "回收站",
  restore: "恢复",
  purge: "彻底删除",
  clearTrash: "清空回收站",
  emptyTitle: "回收站是空的",
  dlgClear: "清空回收站？",
  batchSuccess: (n) => `成功 ${n} 项`,
  dlgDesc: (items, total) =>
    `共 ${items} 项条目，含子页面共 ${total} 篇。页面与它的全部版本记录会被永久删除，无法恢复。`
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"]
})
const PROXY = { server: "http://127.0.0.1:7890" }

async function addSession(context, token) {
  await context.addCookies([
    {
      name: "ciki_session",
      value: token,
      domain: "ciki.oneboy.app",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax"
    }
  ])
}
const rowTitle = (page, title) =>
  page.getByRole("row").filter({ has: page.getByText(title, { exact: true }) })
async function waitTrashLoaded(page) {
  await page.waitForFunction(
    () =>
      document.querySelectorAll("tbody tr").length > 0 ||
      document.body.innerText.includes("回收站是空的"),
    { timeout: 20000 }
  )
  await page.waitForTimeout(400)
}
async function rowTitles(page) {
  const n = (await page.getByRole("row").count()) - 1
  const out = []
  for (let i = 1; i <= n; i++) {
    const t = await page.getByRole("row").nth(i).locator("td").nth(2).innerText()
    out.push(t.split("\n")[0])
  }
  return out
}
async function readDialog(page) {
  const dlg = page.getByRole("alertdialog")
  const title = await dlg.getByRole("heading").first().innerText()
  const desc = await dlg.innerText()
  return { title, desc }
}

try {
  // ---- A 上下文 ----
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block",
    proxy: PROXY
  })
  await addSession(ctxA, process.env.A_SESSION)
  ctxA.on("request", (req) => {
    if (req.url().includes("/api/")) newMetrics.push({ tag: "A", method: req.method(), url: req.url().replace(BASE, "") })
  })
  const page = await ctxA.newPage()
  page.setDefaultTimeout(15000)

  // ============ 口径 4c：接口负例（A 对只读空间条目 P6/P7） ============
  {
    const g1 = await ctxA.request.post(`${BASE}/api/pages/trash/batch`, {
      data: { action: "restore", ids: [Number(P(6))] }
    })
    const g1body = await g1.json().catch(() => ({}))
    const still1 = d1(`SELECT deleted_at FROM pages WHERE id=${P(6)}`)
    const g1rejected = g1.status() !== 200 || g1body?.results?.[0]?.ok === false
    rec("4c-api-batch-restore", "口径4",
      "接口负例：A 批量恢复只读条目 → 被拒且数据未变",
      `http=${g1.status()} ok=${g1body?.results?.[0]?.ok} deleted_at=${still1[0]?.deleted_at}`,
      g1rejected && still1[0]?.deleted_at !== null)

    const g2 = await ctxA.request.post(`${BASE}/api/pages/trash/batch`, {
      data: { action: "purge", ids: [Number(P(6)), Number(P(7))] }
    })
    const g2body = await g2.json().catch(() => ({}))
    const still2 = d1(`SELECT id, deleted_at FROM pages WHERE id IN (${P(6)},${P(7)})`)
    const g2rejected = g2.status() !== 200 || (g2body?.results?.every((r) => r.ok === false) ?? false)
    rec("4c-api-batch-purge", "口径4",
      "接口负例：A 批量彻删只读条目 → 被拒且两页仍在回收站",
      `http=${g2.status()} oks=${JSON.stringify(g2body?.results?.map((r) => r.ok) ?? null)} rows=${still2.length}`,
      still2.length === 2 && still2.every((r) => r.deleted_at !== null) && g2rejected)

    const g3 = await ctxA.request.post(`${BASE}/api/pages/${P(6)}/permanent`)
    const still3 = d1(`SELECT deleted_at FROM pages WHERE id=${P(6)}`)
    rec("4c-api-permanent", "口径4",
      "接口负例：A 单条彻删只读条目 → 拒绝且数据未变",
      `http=${g3.status()} deleted_at=${still3[0]?.deleted_at}`,
      g3.status() !== 200 && still3[0]?.deleted_at !== null)

    const g5 = await ctxA.request.post(`${BASE}/api/pages/999999/restore`)
    rec("4c-api-404", "口径5", "接口负例：恢复不存在的页面 → 404", `http=${g5.status()}`, g5.status() === 404)

    await page.goto(`${BASE}/s/${state.SA_SLUG}/trash`, { waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: zh.title }).waitFor()
    await waitTrashLoaded(page)
    const titles = await rowTitles(page)
    rec("4c-ui-still", "口径4", "负例后 UI：A 视图 P6/P7 两行仍在", titles.join(" | "),
      JSON.stringify(titles) === JSON.stringify(["QA254-丙-只读页二", "QA254-丙-只读页"]))
    await shot(page, "16-negatives-after.png")
  }

  // ============ 口径 3d：B 清空（丙空间） ============
  const ctxB = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block",
    proxy: PROXY
  })
  await addSession(ctxB, process.env.B_SESSION)
  ctxB.on("request", (req) => {
    if (req.url().includes("/api/")) newMetrics.push({ tag: "B", method: req.method(), url: req.url().replace(BASE, "") })
  })
  const pageB = await ctxB.newPage()
  pageB.setDefaultTimeout(15000)
  await pageB.goto(`${BASE}/s/${state.SC_SLUG}/trash`, { waitUntil: "domcontentloaded" })
  await pageB.getByRole("heading", { name: zh.title }).waitFor({ timeout: 20000 })
  await waitTrashLoaded(pageB)
  {
    const titles = await rowTitles(pageB)
    rec("3d-b-rows", "口径3", "B（丙管理员）回收站：2 行（P7/P6）", titles.join(" | "),
      JSON.stringify(titles) === JSON.stringify(["QA254-丙-只读页二", "QA254-丙-只读页"]))
    await shot(pageB, "17-b-trash.png")
    const clearEnabled = await pageB.getByRole("button", { name: zh.clearTrash }).isEnabled()
    rec("3d-b-clear-enabled", "口径3", "B 对丙空间有编辑权 → 清空按钮可用", `enabled=${clearEnabled}`, clearEnabled)
    await pageB.getByRole("button", { name: zh.clearTrash }).click()
    await pageB.getByRole("alertdialog").waitFor({ timeout: 5000 })
    const { title, desc } = await readDialog(pageB)
    const okD = desc.includes(zh.dlgDesc(2, 2))
    rec("3d-b-dialog", "口径3", "B 清空弹窗：共 2 项条目，含子页面共 2 篇",
      `title=${title.includes(zh.dlgClear)} desc=${okD}`, title.includes(zh.dlgClear) && okD)
    await shot(pageB, "18-b-clear-dialog.png")
    await pageB.getByRole("alertdialog").getByRole("button", { name: zh.purge }).click()
    await pageB.getByText(zh.batchSuccess(2)).waitFor({ timeout: 10000 })
    rec("3d-b-toast", "口径3", "toast「成功 2 项」", "已捕获", true)
    await pageB.waitForTimeout(600)
    const empty = await pageB.getByText(zh.emptyTitle).count()
    rec("3d-b-empty", "口径3", "清空后 B 视图显示「回收站是空的」", `empty=${empty}`, empty > 0)
    await shot(pageB, "19-b-empty.png")
    const gone = d1(`SELECT COUNT(*) AS n FROM pages WHERE id IN (${P(6)},${P(7)})`)[0].n
    const revGone = d1(`SELECT COUNT(*) AS n FROM page_revisions WHERE page_id IN (${P(6)},${P(7)})`)[0].n
    const ftsGone = d1(`SELECT COUNT(*) AS n FROM pages_fts WHERE page_id IN (${P(6)},${P(7)})`)[0].n
    rec("3d-b-d1", "口径3", "D1：P6/P7 页面/版本/FTS 全部清除（0/0/0）", `page=${gone} rev=${revGone} fts=${ftsGone}`,
      gone === 0 && revGone === 0 && ftsGone === 0)
  }

  // ============ 终态：A 空态 ============
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: zh.title }).waitFor()
  await waitTrashLoaded(page)
  {
    const empty = await page.getByText(zh.emptyTitle).count()
    rec("final-a-empty", "口径1", "终态：A 回收站（全部空间）为空", `empty=${empty}`, empty > 0)
    await shot(page, "20-a-final-empty.png")
  }

  await ctxA.close()
  await ctxB.close()
} catch (err) {
  newResults.push({ id: "FATAL", criterion: "-", expect: "-", actual: String(err?.message || err).slice(0, 500), ok: false })
  process.exitCode = 1
} finally {
  const prior = JSON.parse(fs.readFileSync("/tmp/qa254/out/results.json", "utf8"))
  const merged = [...prior, ...newResults.filter((r) => r.id !== "FATAL")]
  if (newResults.some((r) => r.id === "FATAL")) merged.push(newResults.find((r) => r.id === "FATAL"))
  fs.writeFileSync("/tmp/qa254/out/results.json", JSON.stringify(merged, null, 2))
  const priorM = JSON.parse(fs.readFileSync("/tmp/qa254/out/metrics.json", "utf8"))
  fs.writeFileSync("/tmp/qa254/out/metrics.json", JSON.stringify([...priorM, ...newMetrics], null, 2))
  await browser.close()
  console.log(`\n== 本段 ${newResults.filter((r) => r.ok).length}/${newResults.length} passed；总计 ${merged.filter((r) => r.ok).length}/${merged.length} ==`)
}
