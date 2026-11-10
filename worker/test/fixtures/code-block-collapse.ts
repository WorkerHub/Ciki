/**
 * 代码块折叠三态夹具（契约见 docs/api-contract.md「代码块折叠」）。
 *
 * 纯数据、不 import 任何模块：web 侧（单 B）的用例可以相对路径引用同一份期望值，
 * 跨仓的插件（单 C）以 docs/api-contract.md 里同样三例为准——两处必须逐字一致。
 *
 * - `doc` 可直接当 contentJson 用（`POST /api/import/pages` 收字符串或对象）；
 * - `html` 是「服务端渲染 + 消毒」后的 content_html 逐字期望值，本单的用例拿它
 *   钉住契约形态，改了渲染就必须同时改这里和契约文档；
 * - `reading` 记阅读页初始表现：`absent` 那一条靠「代码行数 > 20」的自动规则，
 *   由前端实现（单 B），后端只负责把三态原样带到 HTML 上。
 */
export type CodeBlockCollapseState = "true" | "false" | "absent"

export interface CodeBlockCollapseFixture {
  state: CodeBlockCollapseState
  /** 阅读页初始表现（前端行为，供单 B 与验证核对，本单不据此断言）。 */
  reading: "折叠" | "展开"
  /** 完整 doc JSON，可直接当 contentJson 用。 */
  doc: CollapseDoc
  /** 渲染 + 消毒后的 content_html，逐字相等。 */
  html: string
}

export interface CollapseDoc {
  type: "doc"
  content: Array<{
    type: "codeBlock"
    attrs: { language: string; collapsed?: boolean }
    content: Array<{ type: "text"; text: string }>
  }>
}

/** 夹具与契约文档共用的语言标记（`code[class="language-js"]`）。 */
export const COLLAPSE_FIXTURE_LANGUAGE = "js"

/** `lines` 行代码：line 1 … line N。行数就是阅读页自动规则的输入。 */
export function codeText(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join(
    "\n"
  )
}

/** 折叠态是「刻意留空」的一维：undefined = 未表态，不写 collapsed 键。 */
function collapseDoc(rows: number, collapsed?: boolean): CollapseDoc {
  const language = COLLAPSE_FIXTURE_LANGUAGE
  return {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: collapsed === undefined ? { language } : { language, collapsed },
        content: [{ type: "text", text: codeText(rows) }]
      }
    ]
  }
}

function collapseHtml(text: string, mark?: "true" | "false"): string {
  const attrs = mark === undefined ? "" : ` data-collapsed="${mark}"`
  return `<pre${attrs}><code class="language-${COLLAPSE_FIXTURE_LANGUAGE}">${text}</code></pre>`
}

/** 3 行：够短，true 的块靠属性折叠，长不长相干。 */
const SHORT_TEXT = codeText(3)
/** 30 行：超过自动规则的 20 行阈值，用来区分 false 与未表态。 */
const LONG_TEXT = codeText(30)

export const CODE_BLOCK_COLLAPSE_FIXTURES: CodeBlockCollapseFixture[] = [
  {
    state: "true",
    reading: "折叠",
    doc: collapseDoc(3, true),
    html: collapseHtml(SHORT_TEXT, "true")
  },
  {
    state: "false",
    reading: "展开",
    doc: collapseDoc(30, false),
    html: collapseHtml(LONG_TEXT, "false")
  },
  {
    state: "absent",
    reading: "折叠",
    doc: collapseDoc(30),
    html: collapseHtml(LONG_TEXT)
  }
]
