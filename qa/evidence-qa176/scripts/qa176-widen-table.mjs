/**
 * 表格单元格内嵌长代码行（pre 白空间不可断行）撑破列 min-content，
 * 使桌面 1132px 内容宽下表格也横向溢出。用法: node widen-table2.mjs <port>
 */
import fs from "node:fs"
const port = process.argv[2] ?? "8905"
const BASE = `http://127.0.0.1:${port}`
const OUT = port === "8905" ? "/tmp/qa176/out-base" : "/tmp/qa176/out-fix"
const token = JSON.parse(fs.readFileSync(`${OUT}/token.json`, "utf8")).token

const COLS = Array.from({ length: 8 }, (_, i) => `ColumnWidthProbe${String(i).padStart(2, "0")}ABCDEFGH`)
const LONG = "超宽表格列的单元格文本故意写得很长以撑破列宽造成横向溢出场景".repeat(3)
const CODELINE = "cellCodeMinContentProbe" + "x".repeat(60)
const header = { type: "tableRow", content: COLS.map((c) => ({ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: c }] }] })) }
const row = { type: "tableRow", content: COLS.map(() => ({
  type: "tableCell",
  content: [
    { type: "paragraph", content: [{ type: "text", text: LONG }] },
    { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: CODELINE }] }
  ]
})) }
const code = 'const focusRing = "聚焦环溢出验证用超长代码行，单词不断行直接撑破容器宽度造成横向滚动场景" + "x"; // ' + "a".repeat(200)
const doc = { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "这是评论输入框聚焦环验收页面的正文第一段：验证发表框、行内回复框、编辑框聚焦时聚焦环左右完整无截断，并核对输入框与正文列的对齐关系。" }] },
  { type: "paragraph", content: [{ type: "text", text: "第二段：页面下方有超宽表格与长代码行，用于验证横向滚动仍被阻截在各自容器内。" }] },
  { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: code }] },
  { type: "table", content: [header, row] }
] }
const res = await fetch(`${BASE}/api/write/pages/1`, {
  method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ title: "聚焦环验收页", content_json: doc })
})
console.log(`${port}: PUT -> ${res.status}`, JSON.stringify(await res.json()).slice(0, 120))
