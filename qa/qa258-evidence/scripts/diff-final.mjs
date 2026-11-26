// QA258 标准 6 最终归因：删除前生产等价实例（pre-6x2.json） vs 生产删除后（prod-6x2.json）
import fs from "node:fs"

const A = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/pre-6x2.json", "utf8")).entries
const B = JSON.parse(fs.readFileSync("/tmp/ciki-qa258-prod/prod-6x2.json", "utf8")).entries

// 四类归因规则：路径匹配 → 分类 + 依据
const RULES = [
  // A. 设计内差异（删除 distill 机制的必然结果）
  { re: /--wiki-max-width$/, cat: "设计内差异", why: "distill 的 42rem 列宽令牌整体删除（各页 vars 一致）" },
  { re: /readviewContainer\.max-width$/, cat: "设计内差异", why: "阅读容器不再消费 max-width，正文列宽不限宽（验收标准 3）" },
  { re: /wikiContent\.max-width$/, cat: "设计内差异", why: "正文 .wiki-content 的 max-width 规则删除" },
  { re: /styleItems/, cat: "设计内差异", why: "设置页风格项 7 项（删前）→ 6 项（删后），索引整体位移" },
  { re: /styleItemCount$/, cat: "设计内差异", why: "同上，数量 7 → 6" },
  { re: /counts\.toggleItems$/, cat: "设计内差异", why: "风格组 7→6、语言组 2 不变，合计 9 → 8" },
  // B. 数据/内容差异（两侧样本数据不同，与风格无关）
  { re: /^read\.counts\.buttons$/, cat: "数据差异", why: "本地样本有一条“自己写的评论”多出「编辑」按钮（13 vs 12）；生产评论由他人写" },
  { re: /notificationsPanel\.text$/, cat: "数据差异", why: "通知文案内容随样本数据不同" },
  { re: /spaces\.counts\.buttons$/, cat: "数据差异", why: "空间数量不同（本地 1 个空间 vs 生产 8 个空间），按钮数随之不同" },
  { re: /counts\.buttons$/, cat: "数据差异", why: "该区块按钮数随生产样本数据量不同（与风格无关）" },
  { re: /email\.(area\.)?badge\./, cat: "数据差异", why: "本地「邮件未配置」outline 徽章 vs 生产「邮件已配置」secondary 徽章（徽章变体不同故取色不同）" },
  { re: /embedFrameSrc$/, cat: "数据差异", why: "Embed 对象 key 不同（本地样本 vs 生产样本）" },
  { re: /embedBlock/, cat: "数据差异", why: "Embed 载具 key 不同导致的取样差异" },
  // C. 取样假象（单独复测后两侧一致）
  { re: /^mobile\.input(\.|$)/, cat: "取样假象", why: "评论输入框在移动端矩阵取样瞬间尚未渲染；explain.mjs 加长等待复测：两侧均为 TEXTAREA，样式逐值一致" },
  { re: /^mobile\.tableCell(\.|$)/, cat: "取样假象", why: "表格单元格在矩阵取样瞬间未渲染；explain.mjs 复测：两侧均 1 表 2 单元格，样式逐值一致" },
  { re: /^mobile\.counts\.tables$/, cat: "取样假象", why: "同上（表格计数取样时机）" },
  { re: /btnDefaultReal$/, cat: "取样假象", why: "首轮未修等待策略时的取样时序假象，修正后两侧均有值且一致" }
]

function flat(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") { out[prefix] = obj; return out }
  if (Array.isArray(obj)) { obj.forEach((v, i) => flat(v, `${prefix}[${i}]`, out)); return out }
  for (const [k, v] of Object.entries(obj)) flat(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

const report = []
for (const key of Object.keys(A)) {
  const fa = flat(A[key]), fb = flat(B[key])
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    const va = JSON.stringify(fa[k]), vb = JSON.stringify(fb[k])
    if (va === vb) continue
    const rule = RULES.find((r) => r.re.test(k))
    report.push({ entry: key, path: k, pre: fa[k], prod: fb[k], cat: rule?.cat ?? "未归类", why: rule?.why ?? null })
  }
}

const cats = {}
for (const r of report) {
  cats[r.cat] = cats[r.cat] || { n: 0, paths: {} }
  cats[r.cat].n++
  const rel = r.path.replace(/^[^.]+\./, "").replace(/\[[^\]]*\]/g, "[*]")
  cats[r.cat].paths[rel] = (cats[r.cat].paths[rel] || 0) + 1
}
const totalFields = Object.keys(A).length
const compared = Object.keys(A).reduce((n, k) => n + Object.keys(flat(A[k])).length, 0)
console.log(`对比条目：${totalFields} 组（6 风格 × 2 模式），字段 ${compared} 个；差异条目 ${report.length} 条`)
for (const [c, v] of Object.entries(cats)) {
  console.log(`\n== ${c}：${v.n} 条`)
  for (const [p, n] of Object.entries(v.paths).sort((a, b) => b[1] - a[1])) {
    const group = report.filter((r) => r.path.replace(/^[^.]+\./, "").replace(/\[[^\]]*\]/g, "[*]") === p)
    const sample = group[0]
    const whys = [...new Set(group.map((g) => g.why))]
    console.log(`   ${p}  ×${n}  — ${whys.join(" / ")}`)
    for (const s2 of group.slice(0, 2)) console.log(`      例：[${s2.entry}] ${JSON.stringify(s2.pre)} -> ${JSON.stringify(s2.prod)}`)
  }
}
const unclassified = report.filter((r) => r.cat === "未归类")
console.log(`\n未归类：${unclassified.length} 条`)
fs.writeFileSync("/tmp/ciki-qa258-prod/drift-report-final.json", JSON.stringify({ at: new Date().toISOString(), compared, diffs: report.length, cats, unclassified, report }, null, 1))
