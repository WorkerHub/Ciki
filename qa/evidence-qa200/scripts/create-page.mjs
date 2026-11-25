// #200 验收造数：创建一篇长文（多个 H2 + 长段落），返回页面 id
const BASE = "http://localhost:9210"

const para = (n) => ({
  type: "paragraph",
  content: [
    {
      type: "text",
      text: `第${n}段——纸面阅读版式验收用长文段落。正文列的宽度应当随可用宽度伸展：取消列宽封顶之后，纸面主题的正文列与 Nova 主题完全一致，页内导航贴靠右缘，正文吃满剩余宽度。这是一段足够长的中文文本，用来把每一行撑满整个正文列宽，从而在截图上能够清楚看出列的右边缘落在哪里。The quick brown fox jumps over the lazy dog, and mixed Latin text should also wrap at the very same right edge, which makes the column boundary unambiguous in both themes and every viewport size we test.`,
    },
    {
      type: "text",
      marks: [{ type: "bold" }],
      text: "加粗片段用于观察字体渲染是否随版式改动发生变化。",
    },
    { type: "text", text: "段落到此结束，下一行继续。" },
  ],
})

const sections = [
  "版式验收的目标与口径",
  "宽视口下的正文列宽",
  "页内导航的位置与行为",
  "窄视口下的表现",
  "颜色与纹理不应改变",
  "字体与行高不应改变",
  "编辑态不受影响",
  "长表格与代码块的溢出",
  "结论与后续观察",
]

const content = []
for (let i = 0; i < sections.length; i++) {
  content.push({
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: `${i + 1}. ${sections[i]}` }],
  })
  content.push(para(i * 3 + 1))
  content.push(para(i * 3 + 2))
  content.push({
    type: "paragraph",
    content: [
      { type: "text", text: `收尾段（${i + 1}）：` },
      {
        type: "text",
        text: "纸面主题与 Nova 主题的差别只保留在颜色、字体、纹理与阅读排版细节，列宽不再是差异项。这一句在每个小节里重复出现，便于截图对照时逐节确认右缘对齐情况。",
      },
    ],
  })
}

const payload = {
  title: "纸面版式验收·长文（#200 对照样本）",
  content_json: { type: "doc", content },
}

const jar = (await import("node:fs")).readFileSync("/tmp/qa-200/cookies.txt", "utf8")
const token = jar.match(/ciki_session[ \t]+([A-Za-z0-9_-]+)/)?.[1]
if (!token) throw new Error("no session token in cookies.txt")

const res = await fetch(`${BASE}/api/write/pages`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.WT}`,
  },
  body: JSON.stringify(payload),
})
const body = await res.json()
console.log(res.status, JSON.stringify(body))
