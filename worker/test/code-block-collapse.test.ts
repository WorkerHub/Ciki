/**
 * 代码块折叠三态（契约：docs/api-contract.md「代码块折叠」）。
 *
 * 覆盖本单的四件事：三态渲染出的 HTML 标记与夹具逐字一致、导入链路（JSON → HTML →
 * 消毒）把属性原样带出、非法值在 400 里显形、以及折叠只是节点属性——属性变化照常
 * 算一次编辑存版（无改动的判等口径不变）。
 */
import { describe, expect, it } from "vitest"
import {
  CODE_BLOCK_COLLAPSE_FIXTURES,
  codeText
} from "./fixtures/code-block-collapse"
import { normalizeImportedContent } from "../src/lib/page-input"
import { sanitizePageHtml, toPlainText } from "../src/lib/sanitize"
import { renderTiptapHtml } from "../src/lib/tiptap-html"
import { initializedContext, jsonRequest } from "./support/app"
import { adminWithPage, getRevision, listRevisions } from "./support/revisions"

/** 一份只含 codeBlock 的 doc，attrs 原样传入（用来构造非法值）。 */
function codeBlockDoc(attrs: Record<string, unknown>, text = "line 1") {
  return {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs,
        content: [{ type: "text", text }]
      }
    ]
  }
}

function importedHtml(contentJson: unknown): {
  ok: boolean
  contentHtml: string
  contentJson: string
  contentText: string
  code?: string
  error?: string
} {
  const result = normalizeImportedContent({ title: "折叠代码", contentJson })
  if (!result.ok) {
    return {
      ok: false,
      contentHtml: "",
      contentJson: "",
      contentText: "",
      code: result.code,
      error: result.error
    }
  }
  return {
    ok: true,
    contentHtml: result.value.contentHtml,
    contentJson: result.value.contentJson,
    contentText: result.value.contentText
  }
}

describe("代码块折叠：三态渲染与夹具", () => {
  for (const fixture of CODE_BLOCK_COLLAPSE_FIXTURES) {
    it(`${fixture.state}：渲染 + 消毒后的 HTML 与夹具逐字相等`, () => {
      expect(sanitizePageHtml(renderTiptapHtml(fixture.doc))).toBe(fixture.html)
    })
  }

  it("未表态不产出任何属性（含 attrs 缺失的存量块），明确 true/false 才输出", () => {
    const absent = CODE_BLOCK_COLLAPSE_FIXTURES.find(
      (item) => item.state === "absent"
    )
    expect(absent?.html).not.toContain("data-collapsed")
    // 存量块可能连 attrs 都没有，渲染路径不能因为属性缺失报错。
    expect(
      renderTiptapHtml({
        type: "doc",
        content: [
          { type: "codeBlock", content: [{ type: "text", text: "select 1" }] }
        ]
      })
    ).toBe("<pre><code>select 1</code></pre>")
    // 显式 null 与缺省同口径：接受、渲染成裸 <pre>。
    expect(
      importedHtml(codeBlockDoc({ language: "js", collapsed: null }))
        .contentHtml
    ).toBe('<pre><code class="language-js">line 1</code></pre>')
  })
})

describe("代码块折叠：导入链路", () => {
  it("折叠态从 JSON 带到消毒后的 content_html，contentJson 原样落库", () => {
    const fixture = CODE_BLOCK_COLLAPSE_FIXTURES[0]
    const contentJson = JSON.stringify(fixture.doc)
    const imported = importedHtml(contentJson)
    expect(imported.ok).toBe(true)
    expect(imported.contentHtml).toBe(fixture.html)
    expect(imported.contentJson).toBe(contentJson)
    expect(imported.contentJson).toContain('"collapsed":true')
  })

  it("折叠是显示状态：纯文本/搜索口径里没有任何属性残留", () => {
    const fixture = CODE_BLOCK_COLLAPSE_FIXTURES[1]
    const imported = importedHtml(fixture.doc)
    expect(imported.contentHtml).toContain('data-collapsed="false"')
    expect(imported.contentText).not.toContain("collapsed")
    expect(imported.contentText).not.toContain("data-")
    // 与不带该属性的同一段代码产出同一份纯文本：FTS 与搜索不受折叠态影响。
    expect(imported.contentText).toBe(toPlainText(fixture.html))
    expect(imported.contentText).toBe(codeText(30).replace(/\n/g, " "))
  })
})

describe("代码块折叠：非法值", () => {
  for (const value of ["true", "false", 1, 0, {}] as unknown[]) {
    it(`collapsed = ${JSON.stringify(value)} 按 INVALID_CONTENT_JSON 拒绝`, () => {
      const imported = importedHtml(codeBlockDoc({ collapsed: value }))
      expect(imported.ok).toBe(false)
      expect(imported.code).toBe("INVALID_CONTENT_JSON")
      expect(imported.error).toContain("collapsed")
    })
  }
})

describe("代码块折叠：属性变化照常算一次编辑存版", () => {
  it("只改 collapsed（HTML/纯文本不变）也追加一条 revision", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "折叠判等页")

    const foldedJson = JSON.stringify(
      codeBlockDoc({ language: "js", collapsed: true })
    )
    const expandedJson = JSON.stringify(
      codeBlockDoc({ language: "js", collapsed: false })
    )
    const body = (contentJson: string) => ({
      title: "折叠判等页",
      contentJson,
      // 客户端 HTML/纯文本两版完全相同：判等若只看这两列就该判成无改动。
      contentHtml: '<pre data-collapsed="true"><code>line 1</code></pre>',
      contentText: "line 1"
    })

    const put = (contentJson: string) =>
      jsonRequest(env, "PUT", `/api/pages/${page.id}`, body(contentJson), admin)

    expect((await put(foldedJson)).status).toBe(200)
    expect((await put(expandedJson)).status).toBe(200)

    // 建页 1 条 + 两次保存各 1 条：属性变化算编辑，不做去重。
    const revisions = await listRevisions(env, admin, page.id)
    expect(revisions).toHaveLength(3)

    // 版本预览按 JSON 重渲染，折叠态跟着 JSON 走。
    const latest = (await (
      await getRevision(env, admin, page.id, revisions[0].versionNo)
    ).json()) as { contentHtml: string }
    expect(latest.contentHtml).toContain('data-collapsed="false"')
  })
})
