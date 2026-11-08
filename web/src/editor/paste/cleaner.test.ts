import { describe, expect, it } from "vitest"
import { analyzeHtml } from "@/editor/paste/analyze"
import { cleanConfluenceHtml } from "@/editor/paste/cleaner"
import {
  SAMPLE_CONFLUENCE_HTML,
  SAMPLE_SH_TABLE_HTML
} from "@/editor/paste/samples"

/**
 * 粘贴清洗断言 —— 从小样 v0.4 的 test/cleaner.test.mjs 原样移植（30 条），
 * 断言不得删改放宽：这些数字是 2026-11-07 用真实 Confluence 文档跑出来的基线。
 */
describe("Confluence 清洗管线（小样 v0.4 断言）", () => {
  const cleaned = cleanConfluenceHtml(SAMPLE_CONFLUENCE_HTML)
  const stats = analyzeHtml(cleaned)

  it("标题总数 = 6（h1、h2×3、h3、h4）", () => {
    expect(stats.headings.total).toBe(6)
  })

  it("代码块 = 2", () => {
    expect(stats.codeBlocks).toHaveLength(2)
  })

  it("代码块 1 语言 = java", () => {
    expect(stats.codeBlocks[0]?.lang).toBe("java")
  })

  it("代码块 2 语言 = sql", () => {
    expect(stats.codeBlocks[1]?.lang).toBe("sql")
  })

  it("代码块无高亮 span 残留", () => {
    expect(cleaned).not.toMatch(/<span[^>]*class="token/)
  })

  it("代码内容完整（PaymentApplication）", () => {
    expect(cleaned).toContain("PaymentApplication")
  })

  it("表格 = 1", () => {
    expect(stats.tables).toHaveLength(1)
  })

  it("表格行数 = 5", () => {
    expect(stats.tables[0]?.rows).toBe(5)
  })

  it("表头单元格 = 4（1 个合并 + 3 个列头）", () => {
    expect(stats.tables[0]?.headerCells).toBe(4)
  })

  it("合并单元格 = 2（colspan3 + rowspan2）", () => {
    expect(stats.mergedCells).toBe(2)
  })

  it("confluence 类名已剥除", () => {
    expect(cleaned).not.toMatch(/confluence(Th|Td|Table)/)
  })

  it("任务项 = 2，已勾 = 1", () => {
    expect(stats.taskItems).toBe(2)
    expect(stats.taskChecked).toBe(1)
  })

  it("列表最大深度 ≥ 3", () => {
    expect(stats.maxListDepth).toBeGreaterThanOrEqual(3)
  })

  it("链接 = 1", () => {
    expect(stats.links).toBe(1)
  })

  it("图片 = 1 且标记为未转存", () => {
    expect(stats.images).toHaveLength(1)
    expect(stats.images[0]?.confluence).toBe(true)
  })

  it("面板降级为引用块（至少 3 个：2 个面板 + 1 个引用）", () => {
    expect(stats.blockquotes).toBeGreaterThanOrEqual(3)
  })

  it("分割线 = 1", () => {
    expect(stats.hrs).toBe(1)
  })

  it("行内代码 ≥ 3", () => {
    expect(stats.inlineCode).toBeGreaterThanOrEqual(3)
  })

  it("无 script/style 残留", () => {
    expect(cleaned).not.toMatch(/<(script|style)/)
  })

  it("无未知标签", () => {
    expect(stats.unknownTags).toEqual([])
  })

  it("列宽 colgroup 保留", () => {
    expect(cleaned).toContain("<col")
    expect(cleaned).toContain('width="40%"')
  })

  it("表头有字计数 = 表头总数（表头文字没有丢）", () => {
    expect(stats.tables[0]?.headerTextCells).toBe(stats.tables[0]?.headerCells)
  })
})

describe("形态二：SyntaxHighlighter 表格型代码块", () => {
  const cleaned = cleanConfluenceHtml(SAMPLE_SH_TABLE_HTML)
  const stats = analyzeHtml(cleaned)

  it("代码块 = 1", () => {
    expect(stats.codeBlocks).toHaveLength(1)
  })

  it("语言 = sql", () => {
    expect(stats.codeBlocks[0]?.lang).toBe("sql")
  })

  it("代码行数 = 3", () => {
    expect(stats.codeBlocks[0]?.lines).toBe(3)
  })

  it("不产生内容表格", () => {
    expect(stats.tables).toHaveLength(0)
  })

  it("行号列被丢弃（没有 123 串）", () => {
    expect(cleaned).not.toContain(">123<")
    expect(cleaned).not.toContain("123</div>")
  })

  it("逐词 code 已合并（行内代码 = 0）", () => {
    expect(stats.inlineCode).toBe(0)
  })

  it("代码文本完整", () => {
    expect(cleaned).toContain("user_login_table")
    expect(cleaned).toContain("group")
    expect(cleaned).toContain("user_id")
  })

  it("后续正文保留", () => {
    expect(cleaned).toContain("代码块后面的正文")
  })
})

/**
 * 契约变更配套：图片地址白名单必须与后端消毒规则同义。
 * 尤其是 data-original-src —— 读态会把它渲染成可点击链接，
 * 所以 javascript:/data:text/html/svg 数据地址必须在清洗阶段就丢掉。
 */
describe("图片地址：本站图床保留、危险地址丢弃", () => {
  const UUID = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b"
  const img = (src: string) =>
    cleanConfluenceHtml(`<p><img src="${src}" alt="图"></p>`)

  it("本站图床地址原样保留", () => {
    const cleaned = img(`/api/files/${UUID}.png`)
    expect(cleaned).toContain(`src="/api/files/${UUID}.png"`)
    expect(cleaned).not.toContain("data-original-src")
  })

  it("新前缀的本站图床地址同样原样保留，avatars/ 不算正文图", () => {
    for (const category of ["pages", "imports"]) {
      const src = `/api/files/${category}/${UUID}.png`
      const cleaned = img(src)
      expect(cleaned).toContain(`src="${src}"`)
      expect(cleaned).not.toContain("data-original-src")
    }

    const avatar = img(`/api/files/avatars/${UUID}.png`)
    expect(avatar).not.toMatch(/<img[^>]*\ssrc=/)
    expect(avatar).toContain('data-confluence-img="true"')
  })

  it("合规内联图（png base64）保留", () => {
    const cleaned = img("data:image/png;base64,iVBORw0KGgo=")
    expect(cleaned).toContain('src="data:image/png;base64,iVBORw0KGgo="')
  })

  it("http(s) 外链改成未转存标记，原地址保留", () => {
    const cleaned = img("https://confluence.example.com/download/a.png")
    expect(cleaned).not.toContain("<img src=")
    expect(cleaned).toContain(
      'data-original-src="https://confluence.example.com/download/a.png"'
    )
    expect(cleaned).toContain('data-confluence-img="true"')
  })

  it("javascript: 协议被丢弃", () => {
    const cleaned = img("javascript:alert(1)")
    expect(cleaned).not.toContain("javascript:")
    expect(cleaned).not.toContain("data-original-src")
    expect(cleaned).toContain('data-confluence-img="true"')
  })

  it("data:text/html 与 svg 内联图被丢弃（不收 svg）", () => {
    expect(
      img("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")
    ).not.toContain("data-original-src")
    const svg = img("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")
    expect(svg).not.toContain("<img src=")
    expect(svg).not.toContain("data-original-src")
  })

  it("伪装成本站图床但路径不合规的地址也会被转成未转存", () => {
    const cleaned = img("/api/files/evil.png")
    // 自身 src 必须消失；根相对地址仍然可以作为「原地址」保留
    expect(cleaned).not.toMatch(/<img[^>]*\ssrc=/)
    expect(cleaned).toContain('data-confluence-img="true"')
  })
})
