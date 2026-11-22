import { Editor } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  canStepFontSize,
  currentFontSize,
  selectionFontSize,
  setFontSize,
  stepFontSize
} from "@/editor/font-size/commands"
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

  it("选区字号探测与混排识别（selectionFontSize）", () => {
    // 1. 全部默认
    const ed1 = makeEditor("<p>默认文本</p>")
    ed1.commands.selectAll()
    expect(selectionFontSize(ed1)).toEqual({ size: null, isMixed: false })

    // 2. 全部统一字号
    const ed2 = makeEditor('<p><span data-font-size="20px">统一大号</span></p>')
    ed2.commands.selectAll()
    expect(selectionFontSize(ed2)).toEqual({ size: "20px", isMixed: false })

    // 3. 部分文字有字号、部分为默认（混排）
    const ed3 = makeEditor('<p>默认<span data-font-size="20px">大号</span></p>')
    ed3.commands.selectAll()
    expect(selectionFontSize(ed3)).toEqual({ size: null, isMixed: true })
    expect(currentFontSize(ed3)).toBeNull()

    // 4. 多种不同字号混排
    const ed4 = makeEditor(
      '<p><span data-font-size="14px">小</span><span data-font-size="24px">大</span></p>'
    )
    ed4.commands.selectAll()
    expect(selectionFontSize(ed4)).toEqual({ size: null, isMixed: true })
    expect(currentFontSize(ed4)).toBeNull()
  })

  it("沿刻度阶梯逐档步进（stepFontSize & canStepFontSize）", () => {
    const editor = makeEditor("<p>步进测试文本</p>")
    editor.commands.selectAll()

    // 初始为默认（null）
    expect(currentFontSize(editor)).toBeNull()
    expect(canStepFontSize(editor, "down")).toBe(false)
    expect(canStepFontSize(editor, "up")).toBe(true)

    // 步进 +：默认 -> 12px
    stepFontSize(editor, "up")
    expect(currentFontSize(editor)).toBe("12px")
    expect(canStepFontSize(editor, "down")).toBe(true)

    // 步进 -：12px -> 默认（清除）
    stepFontSize(editor, "down")
    expect(currentFontSize(editor)).toBeNull()

    // 连续步进 + 到顶 32px
    const expectedSteps = [
      "12px",
      "14px",
      "16px",
      "18px",
      "20px",
      "24px",
      "32px"
    ] as const
    for (const expected of expectedSteps) {
      stepFontSize(editor, "up")
      expect(currentFontSize(editor)).toBe(expected)
    }

    // 达到 32px 到顶不可再增
    expect(canStepFontSize(editor, "up")).toBe(false)
    expect(canStepFontSize(editor, "down")).toBe(true)
    stepFontSize(editor, "up")
    expect(currentFontSize(editor)).toBe("32px")

    // 降一档回到 24px
    stepFontSize(editor, "down")
    expect(currentFontSize(editor)).toBe("24px")
  })
})
