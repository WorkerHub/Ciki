import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { currentFontSize, setFontSize } from "@/editor/font-size/commands"
import { currentTextColor, setTextColor } from "@/editor/colors/commands"
import { createExtensions } from "@/editor/extensions"
import { ALLOWED_FONT_SIZES, normalizeFontSize } from "@/lib/font-size"
import { docJson } from "@/test/tiptap-json"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const editors: Editor[] = []

function makeEditor(content: string): Editor {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createExtensions("edit"),
    content
  })
  editors.push(editor)
  return editor
}

function jsonText(editor: Editor, index = 0) {
  return docJson(editor).content?.[index]?.content?.[0]
}

describe("字号值归一（normalizeFontSize）", () => {
  it("7 档合法刻度归一成小写 px 字符串", () => {
    for (const size of ALLOWED_FONT_SIZES) {
      expect(normalizeFontSize(size)).toBe(size)
      expect(normalizeFontSize(` ${size.toUpperCase()} `)).toBe(size)
    }
  })

  it("非法数值与相对单位返回 null（不收任意 CSS 数值）", () => {
    expect(normalizeFontSize("10px")).toBeNull()
    expect(normalizeFontSize("15px")).toBeNull()
    expect(normalizeFontSize("22px")).toBeNull()
    expect(normalizeFontSize("36px")).toBeNull()
    expect(normalizeFontSize("1rem")).toBeNull()
    expect(normalizeFontSize("1.5em")).toBeNull()
    expect(normalizeFontSize("100%")).toBeNull()
    expect(normalizeFontSize("large")).toBeNull()
    expect(normalizeFontSize("")).toBeNull()
    expect(normalizeFontSize(null)).toBeNull()
    expect(normalizeFontSize(undefined)).toBeNull()
  })
})

describe("行内字号命令与编辑器模型", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    while (editors.length) editors.pop()?.destroy()
  })

  it("设置字号写入 textStyle.fontSize，清除后 mark 消失", () => {
    const editor = makeEditor("<p>字号测试</p>")
    editor.commands.selectAll()
    setFontSize(editor, "18px")

    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: null, fontSize: "18px" } }
    ])
    expect(currentFontSize(editor)).toBe("18px")

    const html = editor.getHTML()
    expect(html).toContain('data-font-size="18px"')
    expect(html).toContain("font-size: 18px")

    setFontSize(editor, null)
    expect(jsonText(editor)?.marks ?? []).toEqual([])
    expect(currentFontSize(editor)).toBeNull()
    expect(editor.getHTML()).not.toContain("data-font-size")
  })

  it("传非法刻度给 setFontSize 按清除处理", () => {
    const editor = makeEditor("<p>非法测试</p>")
    editor.commands.selectAll()
    setFontSize(editor, "24px")
    expect(currentFontSize(editor)).toBe("24px")

    // 传入不在白名单的字号
    setFontSize(editor, "99px" as any)
    expect(currentFontSize(editor)).toBeNull()
    expect(jsonText(editor)?.marks ?? []).toEqual([])
  })

  it("行内字号与文字颜色可共存于同一个 textStyle mark", () => {
    const editor = makeEditor("<p>复合样式</p>")
    editor.commands.selectAll()
    setTextColor(editor, "#de350b")
    setFontSize(editor, "20px")

    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#de350b", fontSize: "20px" } }
    ])
    expect(currentTextColor(editor)).toBe("#de350b")
    expect(currentFontSize(editor)).toBe("20px")

    const html = editor.getHTML()
    expect(html).toContain('data-text-color="#de350b"')
    expect(html).toContain('data-font-size="20px"')
    expect(html).toContain("font-size: 20px")

    // 清除字号，文字颜色保留
    setFontSize(editor, null)
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#de350b", fontSize: null } }
    ])
    expect(currentTextColor(editor)).toBe("#de350b")
    expect(currentFontSize(editor)).toBeNull()
    expect(editor.getHTML()).not.toContain("data-font-size")
    expect(editor.getHTML()).toContain('data-text-color="#de350b"')

    // 清除颜色，mark 彻底消失
    setTextColor(editor, null)
    expect(jsonText(editor)?.marks ?? []).toEqual([])
  })

  it("撤销/重做：字号设置与清除能撤销再重做", () => {
    const editor = makeEditor("<p>撤销测试</p>")
    editor.commands.selectAll()
    setFontSize(editor, "32px")
    expect(currentFontSize(editor)).toBe("32px")

    editor.commands.undo()
    expect(currentFontSize(editor)).toBeNull()
    expect(jsonText(editor)?.marks ?? []).toEqual([])

    editor.commands.redo()
    expect(currentFontSize(editor)).toBe("32px")
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: null, fontSize: "32px" } }
    ])
  })

  it("从 data-font-size 载具回读为 textStyle.fontSize", () => {
    const editor = makeEditor(
      '<p><span data-font-size="24px">大号文字</span></p>'
    )
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: null, fontSize: "24px" } }
    ])
    expect(currentFontSize(editor)).toBe("24px")
  })

  it("双载具（data-text-color + data-font-size）回读合并为一个 textStyle mark", () => {
    const editor = makeEditor(
      '<p><span data-text-color="#0052cc" data-font-size="14px">蓝且小</span></p>'
    )
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#0052cc", fontSize: "14px" } }
    ])
    expect(currentTextColor(editor)).toBe("#0052cc")
    expect(currentFontSize(editor)).toBe("14px")
  })

  it("非法 data-font-size 载具只丢弃属性、正文内容完整保留", () => {
    const editor = makeEditor(
      '<p><span data-font-size="999px">不受支持字号</span></p>'
    )
    expect(jsonText(editor)?.text).toBe("不受支持字号")
    expect(jsonText(editor)?.marks ?? []).toEqual([])
    expect(currentFontSize(editor)).toBeNull()
  })

  it("从 style.fontSize 降级解析合法字号", () => {
    const editor = makeEditor(
      '<p><span style="font-size: 16px">普通样式</span></p>'
    )
    expect(jsonText(editor)?.marks).toEqual([
      { type: "textStyle", attrs: { color: null, fontSize: "16px" } }
    ])
    expect(currentFontSize(editor)).toBe("16px")
  })
})
