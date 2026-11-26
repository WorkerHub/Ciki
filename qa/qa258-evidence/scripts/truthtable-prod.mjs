// QA258 标准 5：生产 agent-guide 真值表 vs 生产实测 6×2（12 列 × 24 令牌 = 288 格）
import fs from "node:fs"

const md = fs.readFileSync(process.env.QA_MD || "/tmp/ciki-qa258-prod/prod-agent-guide.md", "utf8")
const data = JSON.parse(fs.readFileSync(process.env.QA_JSON || "/tmp/ciki-qa258-prod/prod-6x2.json", "utf8")).entries
const OUT = process.env.QA_OUT || "/tmp/ciki-qa258-prod/truthtable-result.json"

const COLS = ["nova-light","nova-dark","paper-light","paper-dark","natural-light","natural-dark","eink-light","eink-dark","notion-light","notion-dark","sketch-light","sketch-dark"]
const sec = md.split("## 七、主题配色真值表")[1].split("\n## ")[0]
const tableLines = sec.split("\n").filter((l) => l.trim().startsWith("|"))
function parseCell(cell) {
  const ticks = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  const colored = ticks.filter((t) => /^(#|oklch\(|rgb)/.test(t))
  return colored.length ? colored[colored.length - 1] : null
}
const rows = []
for (const line of tableLines.slice(2)) {
  const cells = line.split("|").slice(1, -1).map((s) => s.trim())
  rows.push({ token: cells[0].replace(/`/g, ""), expected: cells.slice(1).map(parseCell) })
}
function hexToRgb(h) {
  let s = h.replace("#", "")
  if (s.length === 3) s = s.split("").map((c) => c + c).join("")
  if (s.length === 8) s = s.slice(0, 6)
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255]
}
function oklchToRgb(str) {
  const m = str.match(/oklch\(([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\)/)
  if (!m) return null
  let L = parseFloat(m[1]); if (m[2] === "%") L = L / 100
  const C = parseFloat(m[3]), H = parseFloat(m[4])
  const alpha = m[5] !== undefined ? (m[5].endsWith("%") ? parseFloat(m[5]) / 100 : parseFloat(m[5])) : 1
  const h = (H * Math.PI) / 180
  const l_ = L + 0.3963377774 * C * Math.cos(h) + 0.2158037573 * C * Math.sin(h)
  const m_ = L - 0.1055613458 * C * Math.cos(h) - 0.0638541728 * C * Math.sin(h)
  const s_ = L - 0.0894841775 * C * Math.cos(h) - 1.2914855480 * C * Math.sin(h)
  const l = l_ ** 3, mm = m_ ** 3, s = s_ ** 3
  let r = +4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s
  let g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s
  let b = -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s
  const g13 = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
  const cl = (x) => Math.round(Math.max(0, Math.min(1, g13(x))) * 255)
  return [cl(r), cl(g), cl(b), Math.round(alpha * 255)]
}
function norm(v) {
  if (!v) return null
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ")
  if (s.startsWith("#")) return hexToRgb(s)
  if (s.startsWith("oklch(")) return oklchToRgb(s)
  if (s.startsWith("rgb(")) { const m = s.match(/[\d.]+/g); return m ? m.slice(0, 3).concat("255").map(Number) : null }
  return s
}

let pass = 0, fail = 0, skipped = 0
const fails = []
const grid = []
for (const r of rows) {
  const row = { token: r.token, cells: {} }
  for (let i = 0; i < COLS.length; i++) {
    const key = COLS[i]
    const exp = r.expected[i]
    if (exp === null) { skipped++; row.cells[key] = { status: "skip" }; continue }
    const got = r.token === "theme-color (meta)" ? data[key].read.metaColor : (data[key].read.vars[`--${r.token}`] || "").trim()
    const ne = norm(exp), ng = norm(got)
    const good = Array.isArray(ne) && Array.isArray(ng) ? ne.every((x, j) => Math.abs(x - ng[j]) <= 1) : ne === ng
    if (good) { pass++; row.cells[key] = { status: "pass", expected: exp, got } }
    else { fail++; row.cells[key] = { status: "fail", expected: exp, got }; fails.push(`${key} --${r.token}: 期望 ${exp} 实测 ${got}`) }
  }
  grid.push(row)
}
console.log(`真值表核对：${pass} 格一致，${fail} 格不一致，${skipped} 格无数值跳过（令牌行 ${rows.length} × 列 ${COLS.length}）`)
if (fails.length) console.log(fails.slice(0, 40).join("\n"))
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), md: process.env.QA_MD, json: process.env.QA_JSON, pass, fail, skipped, tokens: rows.length, cols: COLS.length, grid, fails }, null, 1))
console.log(`-> ${OUT}`)
