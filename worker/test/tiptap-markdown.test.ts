/**
 * MD 派生（规格一期 §一.4）：夹具驱动——每个用例一对 `fixtures/markdown/<case>.json`
 * 与 `<case>.md`，后者是期望快照，随代码进仓；断言逐字节相等。
 *
 * 覆盖规格点名的类型：标题层级、嵌套列表、任务列表、带语言代码块、含合并单元格表格、
 * 图片、面板（引用块），外加行内标记的保留/丢弃。
 *
 * 夹具目录被 biome 排除（见 biome.json 的 `files.includes`）：期望快照必须逐字节可比，
 * 不能被格式化器重排表格列宽或补结尾换行。
 */
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  CIKI_MD_ORIGIN,
  derivePageMarkdown,
  serializeTiptapMarkdown
} from "../src/lib/tiptap-markdown"
import { TiptapRenderError } from "../src/lib/tiptap-html"

const fixtures = path.resolve(import.meta.dirname, "fixtures/markdown")

function cases(): string[] {
  return readdirSync(fixtures)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
}

function read(name: string, extension: string): string {
  return readFileSync(path.join(fixtures, `${name}.${extension}`), "utf8")
}

describe("TipTap JSON → Markdown 夹具", () => {
  it("规格点名的类型都有夹具", () => {
    const names = cases()
    for (const name of [
      "heading-levels",
      "nested-lists",
      "task-list",
      "code-block-language",
      "table-merged-cells",
      "image",
      "panel-blockquote",
      "marks-dropped"
    ]) {
      expect(names).toContain(name)
    }
  })

  for (const name of cases()) {
    it(name, () => {
      const json = JSON.parse(read(name, "json"))
      expect(serializeTiptapMarkdown(json)).toBe(read(name, "md"))
    })
  }
})

describe("MD 派生的降级口径", () => {
  it("图片的站点前缀是本站完整地址", () => {
    expect(CIKI_MD_ORIGIN).toBe("https://ciki.oneboy.app")
  })

  it("严格版遇到非法文档抛 TiptapRenderError（与 HTML 渲染同一份校验）", () => {
    expect(() =>
      serializeTiptapMarkdown({ type: "doc", content: [{ type: "nope" }] })
    ).toThrow(TiptapRenderError)
  })

  it("派生版永不抛错：坏 JSON 退回纯文本", () => {
    expect(derivePageMarkdown("{不是 JSON", "正文纯文本")).toBe("正文纯文本")
    expect(
      derivePageMarkdown(JSON.stringify({ type: "nope" }), "正文纯文本")
    ).toBe("正文纯文本")
    expect(derivePageMarkdown("", "")).toBe("")
  })

  it("派生版对空文档返回空串（空页面就是空 MD，不是错误）", () => {
    expect(
      derivePageMarkdown(JSON.stringify({ type: "doc" }), "不该用到")
    ).toBe("")
  })
})
