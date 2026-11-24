/**
 * QA #182 加宽页面 1 表格：单元格带 colwidth（tiptap 列宽属性），
 * 渲染链路 cell colwidth → <col width=N> → 读态 TableView <col style="width:Npx">
 * → 命中 .wiki-content 表格的 :has(col[style^="width:"]) 豁免 max-width:100%
 * → 表格总宽 8×705=5640px 超出正文宽，.tableWrapper 容器内横滚（D2 场景）。
 * （#176 实测表格总宽 5638px；不带 colwidth 时表格被 max-width:100% 钳在正文宽内、
 *   长令牌被 break-word 折行吸收，构不成横滚场景，属测试数据退化。）
 * 表头与正文行均含 ~116 字符不可断 ASCII 令牌，令格内内容本身也宽于列。
 * 用法: node qa182-widen.mjs <port> <tag>
 */
import fs from "node:fs"

const port = process.argv[2] ?? "8907"
const tag = process.argv[3] ?? "base"
const BASE = `http://127.0.0.1:${port}`
const OUT = `/tmp/qa176/out-${tag}`

const token = JSON.parse(fs.readFileSync(`${OUT}/token.json`, "utf8")).token

// 表头：8 列各 ~118 字符不可断令牌；每列 colwidth 705px（8 列合计 5640px）
const headerToken = (i) => `ColumnWidthProbe${String(i).padStart(2, "0")}` + "A".repeat(100)
// 正文单元格：~116 字符不可断令牌
const cellToken = (r, c) => `CellProbeR${r}C${String(c).padStart(2, "0")}` + "w".repeat(100)
const LONG = "超宽表格列的单元格文本故意写得很长以撑破列宽造成横向溢出场景".repeat(3)
const COLW = [705]

const header = {
  type: "tableRow",
  content: Array.from({ length: 8 }, (_, i) => ({
    type: "tableHeader",
    attrs: { colwidth: COLW },
    content: [{ type: "paragraph", content: [{ type: "text", text: headerToken(i) }] }]
  }))
}
const asciiRow = {
  type: "tableRow",
  content: Array.from({ length: 8 }, (_, c) => ({
    type: "tableCell",
    attrs: { colwidth: COLW },
    content: [{ type: "paragraph", content: [{ type: "text", text: cellToken(1, c) }] }]
  }))
}
const cnRow = {
  type: "tableRow",
  content: Array.from({ length: 8 }, () => ({
    type: "tableCell",
    attrs: { colwidth: COLW },
    content: [{ type: "paragraph", content: [{ type: "text", text: LONG }] }]
  }))
}
const code = 'const focusRing = "聚焦环溢出验证用超长代码行，单词不断行直接撑破容器宽度造成横向滚动场景" + "x"; // ' + "a".repeat(200)
const doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "这是评论输入框聚焦环验收页面的正文第一段：验证发表框、行内回复框、编辑框聚焦时聚焦环左右完整无截断，并核对输入框与正文列的对齐关系。" }] },
    { type: "paragraph", content: [{ type: "text", text: "第二段：页面下方有超宽表格与长代码行，用于验证横向滚动仍被阻截在各自容器内。" }] },
    { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: code }] },
    { type: "table", content: [header, asciiRow, cnRow] }
  ]
}

const res = await fetch(`${BASE}/api/write/pages/1`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "聚焦环验收页", content_json: doc })
})
console.log(`PUT /api/write/pages/1 -> ${res.status}`)
const body = await res.json()
console.log(JSON.stringify(body).slice(0, 160))
if (res.status !== 200) process.exit(1)
