/**
 * QA254 生产 UI 跑批（真实 Chromium + 真实会话 Cookie + 真实生产接口）
 * 覆盖 5 条验收口径；每步记录 {id, 口径, 断言, 实际, 结论} 到 results.json，
 * 截图到 evidence/shots/，接口调用清单到 metrics.json。凭证只读环境变量，绝不落盘。
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

const results = []
const metrics = []
function rec(id, criterion, expect, actual, ok) {
  results.push({ id, criterion, expect, actual: String(actual), ok: !!ok })
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
  allSpaces: "全部空间",
  summary: "汇总全部空间。",
  readOnlyNote: "你是只读成员，只能查看。",
  emptyTitle: "回收站是空的",
  restore: "恢复",
  purge: "彻底删除",
  clearTrash: "清空回收站",
  selectAll: "全选",
  batchSelected: (n) => `已选 ${n} 项`,
  batchRestore: "批量恢复",
  batchPurge: "批量彻底删除",
  batchSuccess: (n) => `成功 ${n} 项`,
  dlgSingle: (t) => `彻底删除「${t}」？`,
  dlgBatch: (n) => `彻底删除选中的 ${n} 项？`,
  dlgClear: "清空回收站？",
  dlgDesc: (items, total) =>
    `共 ${items} 项条目，含子页面共 ${total} 篇。页面与它的全部版本记录会被永久删除，无法恢复。`
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--proxy-server=http://127.0.0.1:7890", "--no-sandbox"]
})

function trackRequests(context, tag) {
  context.on("request", (req) => {
    const url = req.url()
    if (url.includes("/api/")) {
      metrics.push({ tag, method: req.method(), url: url.replace(BASE, "") })
    }
  })
}

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

// 行定位：按标题单元格精确匹配（避免「只读页」误命中「只读页二」）
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
async function dataRows(page) {
  return (await page.getByRole("row").count()) - 1
}
async function rowTitles(page) {
  const out = []
  const n = await dataRows(page)
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
async function cancelDialog(page) {
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click()
  await page.getByRole("alertdialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
}
async function checkRow(page, title) {
  await rowTitle(page, title).getByRole("checkbox").click()
  await page.waitForTimeout(300)
}
// 切换筛选以清空选区（TrashPage 在筛选变化时重置 selectedIds）
async function resetSelection(page, filterSelect) {
  await filterSelect.click()
  await page.getByRole("option", { name: "QA254 空间甲", exact: true }).click()
  await waitTrashLoaded(page)
  await filterSelect.click()
  await page.getByRole("option", { name: zh.allSpaces, exact: true }).click()
  await waitTrashLoaded(page)
}

try {
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block"
  })
  await addSession(ctxA, process.env.A_SESSION)
  trackRequests(ctxA, "A")
  const page = await ctxA.newPage()
  page.setDefaultTimeout(15000)

  // ---- 自证登录 ----
  await page.goto(`${BASE}/s/${state.SA_SLUG}/trash`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: zh.title }).waitFor({ timeout: 20000 })
  await waitTrashLoaded(page)
  const who = await page.locator("body").innerText()
  rec("A-login", "自证", "回收站页可访问（会话 Cookie 生效）", `标题渲染=${who.includes(zh.title)}`, who.includes(zh.title))
  await shot(page, "00-a-trash-initial.png")

  // ============ 口径 1 ============
  const expectedAll = [
    ["QA254-乙-清空全部用页", "QA254 空间乙", 0],
    ["QA254-甲-子树页-批量恢复用", "QA254 空间甲", 1],
    ["QA254-甲-清空单空间用页", "QA254 空间甲", 0],
    ["QA254-甲-版本历史页", "QA254 空间甲", 0],
    ["QA254-丙-只读页二", "QA254 空间丙", 0],
    ["QA254-丙-只读页", "QA254 空间丙", 0],
    ["QA254-乙-待单条彻删", "QA254 空间乙", 0],
    ["QA254-乙-单页", "QA254 空间乙", 0],
    ["QA254-甲-父页-含子树", "QA254 空间甲", 2]
  ]
  {
    const n = await dataRows(page)
    rec("1a-rows", "口径1", "默认全部空间：9 个根条目（子页隐藏，由根条目 childCount 表达）", `实际 ${n} 行`, n === 9)
    const titles = await rowTitles(page)
    const ok = JSON.stringify(titles) === JSON.stringify(expectedAll.map((r) => r[0]))
    rec("1b-order", "口径1", "行序为删除时间倒序：P9→P10→P12→P8→P7→P6→P5→P4→P1", titles.join(" | "), ok)
    let spaceOk = true, timeOk = true, childOk = true
    const childSeen = {}
    for (let i = 1; i <= n; i++) {
      const row = page.getByRole("row").nth(i)
      const space = (await row.locator("td").nth(1).innerText()).trim()
      const titleCell = await row.locator("td").nth(2).innerText()
      const title = titleCell.split("\n")[0]
      const created = (await row.locator("td").nth(3).innerText()).trim()
      const deleted = (await row.locator("td").nth(4).innerText()).trim()
      const exp = expectedAll[i - 1]
      if (space !== exp[1]) { spaceOk = false; console.log("  space mismatch:", title, "→", space) }
      if (!/\d{4}/.test(created) || !/\d{4}/.test(deleted)) timeOk = false
      const hasChild = titleCell.includes("个子页面")
      childSeen[title] = hasChild ? titleCell.split("\n")[1] : null
      if ((exp[2] > 0) !== hasChild) childOk = false
      if (exp[2] > 0 && !titleCell.includes(`含 ${exp[2]} 个子页面`)) childOk = false
    }
    rec("1c-space", "口径1", "每行空间列与其空间一致（甲/乙/丙）", spaceOk ? "9/9 一致" : "存在不一致", spaceOk)
    rec("1d-time", "口径1", "创建/删除时间列均渲染日期", timeOk ? "9/9 渲染" : "存在缺失", timeOk)
    rec("2a-childcount", "口径2", "子页面数：P1 行含 2 个子页面、P10 行含 1 个子页面、其余不显示", JSON.stringify(childSeen), childOk)
    const headerText = await page.locator("header").filter({ hasText: "回收站" }).innerText()
    rec("1e-summary", "口径1", "页头声明「汇总全部空间。」", `包含=${headerText.includes(zh.summary)}`, headerText.includes(zh.summary))
  }
  const filterSelect = page.getByRole("combobox", { name: "空间" })
  async function applyFilter(page_, label) {
    await filterSelect.click()
    await page.getByRole("option", { name: label, exact: true }).click()
    await waitTrashLoaded(page_)
  }

  await applyFilter(page, "QA254 空间乙")
  {
    const titles = await rowTitles(page)
    const ok = JSON.stringify(titles) === JSON.stringify(["QA254-乙-清空全部用页", "QA254-乙-待单条彻删", "QA254-乙-单页"])
    rec("1f-filter-yi", "口径1", "筛选空间乙 → 3 行（P9/P5/P4）", titles.join(" | "), ok)
    await shot(page, "01-filter-yi.png")
  }
  await applyFilter(page, "QA254 空间丙")
  {
    const titles = await rowTitles(page)
    const headerText = await page.locator("header").filter({ hasText: "回收站" }).innerText()
    const clearDisabled = await page.getByRole("button", { name: zh.clearTrash }).isDisabled()
    const selectAllDisabled = await page.getByRole("checkbox", { name: zh.selectAll }).isDisabled()
    rec("1g-filter-bing", "口径1", "筛选空间丙 → 2 行（P7/P6）", titles.join(" | "), JSON.stringify(titles) === JSON.stringify(["QA254-丙-只读页二", "QA254-丙-只读页"]))
    rec("4a-readonly-note", "口径4", "筛选只读空间：提示「你是只读成员，只能查看。」且清空/全选禁用",
      `提示=${headerText.includes(zh.readOnlyNote)} 清空禁用=${clearDisabled} 全选禁用=${selectAllDisabled}`,
      headerText.includes(zh.readOnlyNote) && clearDisabled && selectAllDisabled)
    await shot(page, "02-filter-bing-readonly.png")
  }
  await applyFilter(page, "QA254 空间甲")
  {
    const titles = await rowTitles(page)
    const ok = JSON.stringify(titles) === JSON.stringify(["QA254-甲-子树页-批量恢复用", "QA254-甲-清空单空间用页", "QA254-甲-版本历史页", "QA254-甲-父页-含子树"])
    rec("1h-filter-jia", "口径1", "筛选空间甲 → 4 行（P10/P12/P8/P1）", titles.join(" | "), ok)
    await shot(page, "03-filter-jia.png")
  }
  await applyFilter(page, zh.allSpaces)
  {
    const n = await dataRows(page)
    rec("1i-filter-back", "口径1", "切回全部空间 → 9 行", `实际 ${n} 行`, n === 9)
  }

  // ============ 口径 2：弹窗计数 ============
  async function openBatchPurgeDialog() {
    await page.getByRole("button", { name: zh.batchPurge }).click()
    await page.getByRole("alertdialog").waitFor({ timeout: 5000 })
  }
  // P1 子树：1 条目 / 3 篇
  await checkRow(page, "QA254-甲-父页-含子树")
  await openBatchPurgeDialog()
  {
    const { title, desc } = await readDialog(page)
    const okD = desc.includes(zh.dlgDesc(1, 3))
    rec("2b-dialog-p1", "口径2", "P1 弹窗：标题=彻底删除选中的 1 项？；共 1 项条目，含子页面共 3 篇",
      `title=${title.includes(zh.dlgBatch(1))} desc=${okD}`,
      title.includes(zh.dlgBatch(1)) && okD)
    await shot(page, "04-dialog-p1-subtree.png")
  }
  await cancelDialog(page)
  await resetSelection(page, filterSelect)

  // P4 + P9：2 条目 / 2 篇
  await checkRow(page, "QA254-乙-单页")
  await checkRow(page, "QA254-乙-清空全部用页")
  await openBatchPurgeDialog()
  {
    const { title, desc } = await readDialog(page)
    const okD = desc.includes(zh.dlgDesc(2, 2))
    rec("2c-dialog-p4p9", "口径2", "P4+P9 弹窗：共 2 项条目，含子页面共 2 篇",
      `title=${title.includes(zh.dlgBatch(2))} desc=${okD}`,
      title.includes(zh.dlgBatch(2)) && okD)
    await shot(page, "05-dialog-p4-p9.png")
  }
  await cancelDialog(page)
  await resetSelection(page, filterSelect)

  // P10 子树：1 条目 / 2 篇
  await checkRow(page, "QA254-甲-子树页-批量恢复用")
  await openBatchPurgeDialog()
  {
    const { title, desc } = await readDialog(page)
    const okD = desc.includes(zh.dlgDesc(1, 2))
    rec("2d-dialog-p10", "口径2", "P10 弹窗：共 1 项条目，含子页面共 2 篇",
      `title=${title.includes(zh.dlgBatch(1))} desc=${okD}`,
      title.includes(zh.dlgBatch(1)) && okD)
    await shot(page, "06-dialog-p10-subtree.png")
  }
  await cancelDialog(page)
  await resetSelection(page, filterSelect)

  // ============ 口径 4：只读行 ============
  await applyFilter(page, "QA254 空间丙")
  {
    const p7 = rowTitle(page, "QA254-丙-只读页二")
    const p7checkbox = await p7.getByRole("checkbox").count()
    const p7restore = await p7.getByRole("button", { name: zh.restore }).count()
    const p7purge = await p7.getByRole("button", { name: zh.purge }).count()
    const p6 = rowTitle(page, "QA254-丙-只读页")
    const p6buttons = await p6.getByRole("button").count()
    rec("4b-readonly-row", "口径4", "只读空间行：无勾选框、无恢复/彻底删除按钮",
      `P7 勾选框=${p7checkbox} 恢复=${p7restore} 彻删=${p7purge}；P6 按钮总数=${p6buttons}`,
      p7checkbox === 0 && p7restore === 0 && p7purge === 0 && p6buttons === 0)
    await shot(page, "07-readonly-rows.png")
  }
  await applyFilter(page, zh.allSpaces)

  // ============ 口径 3a：批量恢复（跨空间 + 子树，P4+P10） ============
  await checkRow(page, "QA254-乙-单页")
  await checkRow(page, "QA254-甲-子树页-批量恢复用")
  {
    const selText = (await page.getByText(/已选 \d+ 项/).innerText()).trim()
    rec("3a-selected", "口径3", "勾选 P4+P10 → 批量条「已选 2 项」", selText, selText === zh.batchSelected(2))
    await shot(page, "08-batch-restore-selected.png")
  }
  await page.getByRole("button", { name: zh.batchRestore }).click()
  {
    await page.getByText(zh.batchSuccess(2)).waitFor({ timeout: 10000 })
    rec("3a-toast", "口径3", "toast「成功 2 项」", "已捕获", true)
    const dlgVisible = await page.getByRole("alertdialog").isVisible().catch(() => false)
    rec("3a-no-dialog", "口径3", "批量恢复不出现确认弹窗", dlgVisible ? "出现了弹窗" : "无弹窗", !dlgVisible)
    await shot(page, "09-batch-restore-toast.png")
    await page.waitForTimeout(600)
    const titles = await rowTitles(page)
    const ok = !titles.includes("QA254-乙-单页") && !titles.includes("QA254-甲-子树页-批量恢复用") && titles.length === 7
    rec("3a-rows-after", "口径3", "恢复后 P4/P10 行消失（P11 随父恢复）→ 7 行", titles.join(" | "), ok)
  }
  {
    const d1rows = d1(`SELECT id, deleted_at FROM pages WHERE id IN (${P(4)},${P(10)},${P(11)})`)
    const alive = d1rows.length === 3 && d1rows.every((r) => r.deleted_at === null)
    rec("3a-d1", "口径3", "D1：P4/P10/P11 三页 deleted_at 全部清空（子树整体恢复）", `rows=${d1rows.length} alive=${alive}`, alive)
    const revs = d1(`SELECT COUNT(*) AS n FROM page_revisions WHERE page_id IN (${P(4)},${P(10)},${P(11)})`)[0].n
    rec("3a-d1-rev", "口径3", "恢复不丢版本历史：P4/P10/P11 版本行仍在（≥3）", `实际 ${revs} 行`, revs >= 3)
  }

  // ============ 口径 5a：单条恢复（P8） ============
  {
    await rowTitle(page, "QA254-甲-版本历史页").getByRole("button", { name: zh.restore }).click()
    await page.waitForTimeout(400)
    const dlgVisible = await page.getByRole("alertdialog").isVisible().catch(() => false)
    rec("5a-no-dialog", "口径5", "单条恢复不弹确认框（与改动前一致：即时生效）", dlgVisible ? "出现了弹窗" : "无弹窗", !dlgVisible)
    await page.waitForTimeout(1200)
    const titles = await rowTitles(page)
    rec("5a-row-gone", "口径5", "P8 行消失", titles.join(" | "), !titles.includes("QA254-甲-版本历史页"))
    await shot(page, "10-single-restore-p8.png")
    const prow = d1(`SELECT deleted_at FROM pages WHERE id=${P(8)}`)
    rec("5a-d1", "口径5", "D1：P8 deleted_at=NULL", JSON.stringify(prow[0] ?? null), prow.length === 1 && prow[0].deleted_at === null)
    const revs = d1(`SELECT version_no FROM page_revisions WHERE page_id=${P(8)} ORDER BY version_no`)
    rec("5a-d1-rev", "口径5", "恢复后 P8 全部 4 个版本仍在", `versions=${revs.map((r) => r.version_no).join(",")}`, revs.length === 4)
    const content = d1(`SELECT substr(content_text,1,20) AS tp FROM pages WHERE id=${P(8)}`)
    rec("5a-d1-content", "口径5", "恢复后 P8 正文=v3b（最新版本）", content[0]?.tp, (content[0]?.tp ?? "").startsWith("QA254 P8 正文 v3b"))
  }

  // ============ 口径 5b：单条彻底删除（P5） ============
  {
    await rowTitle(page, "QA254-乙-待单条彻删").getByRole("button", { name: zh.purge }).click()
    await page.getByRole("alertdialog").waitFor({ timeout: 5000 })
    const { title, desc } = await readDialog(page)
    const okT = title === zh.dlgSingle("QA254-乙-待单条彻删")
    const okD = desc.includes(zh.dlgDesc(1, 1))
    rec("5b-dialog", "口径5", "单条彻删弹窗：标题=彻底删除「QA254-乙-待单条彻删」？共 1 项条目，含子页面共 1 篇",
      `title=${okT} desc=${okD}`, okT && okD)
    await shot(page, "11-single-purge-dialog.png")
    await page.getByRole("alertdialog").getByRole("button", { name: zh.purge }).click()
    await page.waitForTimeout(1500)
    const titles = await rowTitles(page)
    rec("5b-row-gone", "口径5", "确认后 P5 行消失", titles.join(" | "), !titles.includes("QA254-乙-待单条彻删"))
    const gone = d1(`SELECT COUNT(*) AS n FROM pages WHERE id=${P(5)}`)[0].n
    const revGone = d1(`SELECT COUNT(*) AS n FROM page_revisions WHERE page_id=${P(5)}`)[0].n
    const ftsGone = d1(`SELECT COUNT(*) AS n FROM pages_fts WHERE page_id=${P(5)}`)[0].n
    rec("5b-d1", "口径5", "D1：P5 页面/版本/FTS 全部删除（0/0/0）", `page=${gone} rev=${revGone} fts=${ftsGone}`,
      gone === 0 && revGone === 0 && ftsGone === 0)
  }

  // ============ 口径 3b：批量彻底删除（跨空间+子树，P1+P9） ============
  await checkRow(page, "QA254-甲-父页-含子树")
  await checkRow(page, "QA254-乙-清空全部用页")
  await openBatchPurgeDialog()
  {
    const { title, desc } = await readDialog(page)
    const okT = title === zh.dlgBatch(2)
    const okD = desc.includes(zh.dlgDesc(2, 4))
    rec("3b-dialog", "口径3", "P1+P9 弹窗：共 2 项条目，含子页面共 4 篇（跨空间+子树计数）",
      `title=${okT} desc=${okD}`, okT && okD)
    await shot(page, "12-batch-purge-dialog.png")
    await page.getByRole("alertdialog").getByRole("button", { name: zh.purge }).click()
    await page.getByText(zh.batchSuccess(2)).waitFor({ timeout: 10000 })
    rec("3b-toast", "口径3", "toast「成功 2 项」", "已捕获", true)
    await shot(page, "13-batch-purge-toast.png")
    await page.waitForTimeout(600)
    const titles = await rowTitles(page)
    rec("3b-rows-after", "口径3", "P1/P9 消失 → 剩 3 行（P12/P7/P6）", titles.join(" | "),
      JSON.stringify(titles) === JSON.stringify(["QA254-甲-清空单空间用页", "QA254-丙-只读页二", "QA254-丙-只读页"]))
  }
  {
    const gone = d1(`SELECT COUNT(*) AS n FROM pages WHERE id IN (${P(1)},${P(2)},${P(3)},${P(9)})`)[0].n
    const revGone = d1(`SELECT COUNT(*) AS n FROM page_revisions WHERE page_id IN (${P(1)},${P(2)},${P(3)},${P(9)})`)[0].n
    const ftsGone = d1(`SELECT COUNT(*) AS n FROM pages_fts WHERE page_id IN (${P(1)},${P(2)},${P(3)},${P(9)})`)[0].n
    rec("3b-d1", "口径3", "D1：P1/P2/P3/P9 页面/版本/FTS 全部清除（0/0/0）", `page=${gone} rev=${revGone} fts=${ftsGone}`,
      gone === 0 && revGone === 0 && ftsGone === 0)
  }

  // ============ 口径 3c：清空全部空间（A；只读丙不计入） ============
  {
    await page.getByRole("button", { name: zh.clearTrash }).click()
    await page.getByRole("alertdialog").waitFor({ timeout: 5000 })
    const { title, desc } = await readDialog(page)
    const okT = title === zh.dlgClear
    const okD = desc.includes(zh.dlgDesc(1, 1))
    rec("3c-dialog", "口径3+4", "清空弹窗：共 1 项条目（仅 P12；只读空间的 P6/P7 不计入）",
      `title=${okT} desc1条1篇=${okD}`, okT && okD)
    await shot(page, "14-clear-all-dialog.png")
    await page.getByRole("alertdialog").getByRole("button", { name: zh.purge }).click()
    await page.getByText(zh.batchSuccess(1)).waitFor({ timeout: 10000 })
    rec("3c-toast", "口径3", "toast「成功 1 项」", "已捕获", true)
    await page.waitForTimeout(600)
    const titles = await rowTitles(page)
    rec("3c-rows-after", "口径3", "P12 清除 → 只剩只读丙 2 行", titles.join(" | "),
      JSON.stringify(titles) === JSON.stringify(["QA254-丙-只读页二", "QA254-丙-只读页"]))
    const gone = d1(`SELECT COUNT(*) AS n FROM pages WHERE id=${P(12)}`)[0].n
    rec("3c-d1", "口径3", "D1：P12 已彻底删除", `page rows=${gone}`, gone === 0)
  }
  {
    const clearDisabled = await page.getByRole("button", { name: zh.clearTrash }).isDisabled()
    rec("3c-clear-disabled", "口径3", "无可编辑条目时清空按钮禁用", `disabled=${clearDisabled}`, clearDisabled)
    await shot(page, "15-only-readonly-left.png")
  }

  // ============ 口径 4c：接口负例（A 对只读空间条目） ============
  {
    const g1 = await ctxA.request.post(`${BASE}/api/pages/trash/batch`, {
      data: { action: "restore", ids: [Number(P(6))] }
    })
    const g1body = await g1.json().catch(() => ({}))
    const still1 = d1(`SELECT deleted_at FROM pages WHERE id=${P(6)}`)
    const g1rejected = g1.status() !== 200 || g1body?.results?.[0]?.ok === false
    rec("4c-api-batch-restore", "口径4",
      "接口负例：批量恢复只读条目 → 被拒且数据未变",
      `http=${g1.status()} ok=${g1body?.results?.[0]?.ok} deleted_at=${still1[0]?.deleted_at}`,
      g1rejected && still1[0]?.deleted_at !== null)

    const g2 = await ctxA.request.post(`${BASE}/api/pages/trash/batch`, {
      data: { action: "purge", ids: [Number(P(6)), Number(P(7))] }
    })
    const g2body = await g2.json().catch(() => ({}))
    const still2 = d1(`SELECT id, deleted_at FROM pages WHERE id IN (${P(6)},${P(7)})`)
    const g2rejected = g2.status() !== 200 || (g2body?.results?.every((r) => r.ok === false) ?? false)
    rec("4c-api-batch-purge", "口径4",
      "接口负例：批量彻删只读条目 → 被拒且两页仍在回收站",
      `http=${g2.status()} oks=${JSON.stringify(g2body?.results?.map((r) => r.ok) ?? null)} rows=${still2.length}`,
      still2.length === 2 && still2.every((r) => r.deleted_at !== null) && g2rejected)

    const g3 = await ctxA.request.post(`${BASE}/api/pages/${P(6)}/permanent`)
    const still3 = d1(`SELECT deleted_at FROM pages WHERE id=${P(6)}`)
    rec("4c-api-permanent", "口径4",
      "接口负例：单条彻删只读条目 → 拒绝且数据未变",
      `http=${g3.status()} deleted_at=${still3[0]?.deleted_at}`,
      g3.status() !== 200 && still3[0]?.deleted_at !== null)

    const g5 = await ctxA.request.post(`${BASE}/api/pages/999999/restore`)
    rec("4c-api-404", "口径5", "接口负例：恢复不存在的页面 → 404", `http=${g5.status()}`, g5.status() === 404)

    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: zh.title }).waitFor()
    await waitTrashLoaded(page)
    const titles = await rowTitles(page)
    rec("4c-ui-still", "口径4", "负例后 UI：P6/P7 两行仍在", titles.join(" | "),
      JSON.stringify(titles) === JSON.stringify(["QA254-丙-只读页二", "QA254-丙-只读页"]))
    await shot(page, "16-negatives-after.png")
  }

  // ============ 口径 3d：B 清空（丙空间唯一管理员视角） ============
  const ctxB = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    serviceWorkers: "block"
  })
  await addSession(ctxB, process.env.B_SESSION)
  trackRequests(ctxB, "B")
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

  // ============ 终态 ============
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
  results.push({ id: "FATAL", criterion: "-", expect: "-", actual: String(err?.stack || err), ok: false })
  process.exitCode = 1
  throw err
} finally {
  fs.writeFileSync("/tmp/qa254/out/results.json", JSON.stringify(results, null, 2))
  fs.writeFileSync("/tmp/qa254/out/metrics.json", JSON.stringify(metrics, null, 2))
  await browser.close()
  console.log(`\n== ${results.filter((r) => r.ok).length}/${results.length} passed ==`)
}
