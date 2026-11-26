// 逐字段比对：删除前生产等价实例（pre-6x2.json） vs 生产删除后（prod-6x2.json）
import fs from "node:fs"

const A = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/pre-6x2.json", "utf8")).entries
const B = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/prod-6x2.json", "utf8")).entries

// 设计内差异（删除 distill 机制必然带来）：白名单
const ALLOWED = [
  { path: "settings.area.styleItems", why: "设置页风格项：删除前 7 项（含 distill）→ 删除后 6 项" },
  { path: "settings.area.styleItemCount", why: "同上，数量 7 → 6" },
  { path: "vars.--wiki-max-width", why: "列宽机制整体移除：令牌声明删除" },
  { path: "readviewContainer.max-width", why: "列宽机制整体移除：消费规则删除" },
  { path: "wikiContent.max-width", why: "列宽机制整体移除：正文列宽回到不限宽" },
  { path: "embedFrameSrc", why: "Embed 对象 key 不同（本地样本 vs 生产样本），非风格差异" },
  { path: "embedBlock", why: "Embed 载具 key 不同导致的取样差异" },
  { path: "contrast.btnDefaultReal", why: "按钮取样时序（页面未渲染完），需复测确认" }
]

function flat(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") { out[prefix] = obj; return out }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flat(v, `${prefix}[${i}]`, out))
    return out
  }
  for (const [k, v] of Object.entries(obj)) flat(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

const report = []
for (const key of Object.keys(A)) {
  const fa = flat(A[key])
  const fb = flat(B[key])
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)])
  for (const k of keys) {
    const va = JSON.stringify(fa[k])
    const vb = JSON.stringify(fb[k])
    if (va === vb) continue
    const allow = ALLOWED.find((a) => k.includes(a.path))
    report.push({ entry: key, path: k, pre: va, prod: vb, classification: allow ? "设计内差异" : "未分类差异", why: allow?.why || null })
  }
}
const unclassified = report.filter((r) => r.classification === "未分类差异")
const allowed = report.filter((r) => r.classification === "设计内差异")
fs.writeFileSync("/tmp/ciki-qa258-prod/diff-pre-vs-prod.json", JSON.stringify(report, null, 1))
console.log(`总差异条目: ${report.length}（设计内 ${allowed.length} / 未分类 ${unclassified.length}）`)

console.log("\n--- 设计内差异（按路径归并）---")
const byPath = {}
for (const r of allowed) {
  if (!byPath[r.path]) byPath[r.path] = { n: 0, why: r.why, sample: `${r.pre} -> ${r.prod}`, entries: [] }
  byPath[r.path].n++
  byPath[r.path].entries.push(r.entry)
}
for (const [p, v] of Object.entries(byPath)) {
  console.log(`  ${p}  ×${v.n}\n      ${v.sample}\n      ${v.why}`)
}

console.log("\n--- 未分类差异（按路径归并，取前 30）---")
const hist = {}
for (const r of unclassified) {
  const rel = r.path.replace(/^[^.]+\./, "")
  const key = rel.replace(/\[[^\]]*\]/g, "[*]")
  if (!hist[key]) hist[key] = { n: 0, sample: r }
  hist[key].n++
}
const sorted = Object.entries(hist).sort((a, b) => b[1].n - a[1].n)
console.log(`  未分类差异路径种类: ${sorted.length}`)
for (const [k, v] of sorted.slice(0, 30)) {
  console.log(`  ${k}  ×${v.n}\n      [${v.sample.entry}] pre : ${v.sample.pre}\n      [${v.sample.entry}] prod: ${v.sample.prod}`)
}
