import { Editor, isNodeSelection } from "@tiptap/core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createExtensions } from "@/editor/extensions"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const editors: Editor[] = []

function cleanupEditors() {
  while (editors.length) {
    const ed = editors.pop()
    const el = ed?.options.element
    if (el instanceof Element) el.remove()
    ed?.destroy()
  }
}

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

function selectFirstNodeOfType(editor: Editor, typeName: string): number {
  let targetPos = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === typeName && targetPos === -1) {
      targetPos = pos
      return false
    }
  })
  expect(targetPos).toBeGreaterThanOrEqual(0)
  editor.commands.setNodeSelection(targetPos)
  expect(isNodeSelection(editor.state.selection)).toBe(true)
  return targetPos
}

describe("块节点选中态（NodeSelection）下插入块级内容防替换", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
  })

  it("1. 选中图片插画布：图片保留，画布紧随其后", () => {
    const editor = makeEditor(
      '<p>前置段落</p><img src="/test.png" alt="测试图片"><p>后置段落</p>'
    )
    selectFirstNodeOfType(editor, "image")

    editor.chain().focus().setExcalidraw().run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "image", "excalidraw", "paragraph"])

    const img = editor.getJSON().content?.[1]
    expect(img?.attrs?.src).toBe("/test.png")
  })

  it("2. 选中图片插 Embed：图片保留，Embed 紧随其后", () => {
    const editor = makeEditor(
      '<p>前置段落</p><img src="/test.png" alt="测试图片"><p>后置段落</p>'
    )
    selectFirstNodeOfType(editor, "image")

    editor
      .chain()
      .focus()
      .setHtmlEmbed({ key: "embeds/test.html", name: "test.html" })
      .run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "image", "htmlEmbed", "paragraph"])

    const img = editor.getJSON().content?.[1]
    expect(img?.attrs?.src).toBe("/test.png")
    const embed = editor.getJSON().content?.[2]
    expect(embed?.attrs?.key).toBe("embeds/test.html")
  })

  it("3. 选中图片插新图片：原图片保留，新图片紧随其后", () => {
    const editor = makeEditor(
      '<p>前置段落</p><img src="/old.png" alt="旧图片"><p>后置段落</p>'
    )
    selectFirstNodeOfType(editor, "image")

    editor.chain().focus().setImage({ src: "/new.png", alt: "新图片" }).run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "image", "image", "paragraph"])

    const img1 = editor.getJSON().content?.[1]
    expect(img1?.attrs?.src).toBe("/old.png")
    const img2 = editor.getJSON().content?.[2]
    expect(img2?.attrs?.src).toBe("/new.png")
  })

  it("4. 选中图片插表格：图片保留，表格紧随其后", () => {
    const editor = makeEditor(
      '<p>前置段落</p><img src="/test.png" alt="测试图片"><p>后置段落</p>'
    )
    selectFirstNodeOfType(editor, "image")

    editor
      .chain()
      .focus()
      .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
      .run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "image", "table", "paragraph"])

    const img = editor.getJSON().content?.[1]
    expect(img?.attrs?.src).toBe("/test.png")
  })

  it("5. 选中画布插 Embed：原画布保留，Embed 在其后", () => {
    const editor = makeEditor(
      '<p>前</p><img data-type="excalidraw" alt="图表"><p>后</p>'
    )
    selectFirstNodeOfType(editor, "excalidraw")

    editor
      .chain()
      .focus()
      .setHtmlEmbed({ key: "embeds/k.html", name: "k.html" })
      .run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "excalidraw", "htmlEmbed", "paragraph"])
  })

  it("6. 选中 Embed 插画布：原 Embed 保留，画布在其后", () => {
    const editor = makeEditor(
      '<p>前</p><div data-type="html-embed" data-key="k.html" data-name="k.html"></div><p>后</p>'
    )
    selectFirstNodeOfType(editor, "htmlEmbed")

    editor.chain().focus().setExcalidraw().run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "htmlEmbed", "excalidraw", "paragraph"])
  })

  it("7. 选中画布插表格 & 选中 Embed 插表格：原块保留，表格紧随其后", () => {
    const edCanvas = makeEditor(
      '<p>前</p><img data-type="excalidraw" alt="图表"><p>后</p>'
    )
    selectFirstNodeOfType(edCanvas, "excalidraw")
    edCanvas
      .chain()
      .focus()
      .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
      .run()
    expect(edCanvas.getJSON().content?.map((n) => n.type)).toEqual([
      "paragraph",
      "excalidraw",
      "table",
      "paragraph"
    ])

    const edEmbed = makeEditor(
      '<p>前</p><div data-type="html-embed" data-key="k.html" data-name="k.html"></div><p>后</p>'
    )
    selectFirstNodeOfType(edEmbed, "htmlEmbed")
    edEmbed
      .chain()
      .focus()
      .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
      .run()
    expect(edEmbed.getJSON().content?.map((n) => n.type)).toEqual([
      "paragraph",
      "htmlEmbed",
      "table",
      "paragraph"
    ])
  })

  it("8. 相邻两张图片排布时，选中第一张插画布：准确插在两图之间，两图均完整保留", () => {
    const editor = makeEditor(
      '<img src="/1.png" alt="图1"><img src="/2.png" alt="图2">'
    )
    selectFirstNodeOfType(editor, "image")

    editor.chain().focus().setExcalidraw().run()

    const content = editor.getJSON().content
    expect(content?.map((n) => n.type)).toEqual([
      "image",
      "excalidraw",
      "image",
      "paragraph"
    ])
    expect(content?.[0].attrs?.src).toBe("/1.png")
    expect(content?.[2].attrs?.src).toBe("/2.png")
  })

  it("9. 光标在普通文本段落中插入画布与 Embed：插在光标处，与现状行为一致", () => {
    const editor = makeEditor("<p>你好世界</p>")
    // 光标在 "你好" 和 "世界" 之间 (pos 3)
    editor.commands.setTextSelection(3)

    editor.chain().focus().setExcalidraw().run()

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(["paragraph", "excalidraw", "paragraph"])
    const p1 = editor.getJSON().content?.[0]
    const p2 = editor.getJSON().content?.[2]
    const text1 = p1?.content?.[0]
    const text2 = p2?.content?.[0]
    expect(text1 && "text" in text1 ? text1.text : "").toBe("你好")
    expect(text2 && "text" in text2 ? text2.text : "").toBe("世界")
  })

  it("10. 文本范围选区（高亮选中文本）插入画布：维持原生替换选区逻辑", () => {
    const editor = makeEditor("<p>待替换文字</p>")
    // 选中整个文本 "待替换文字" (pos 1 到 pos 7)
    editor.commands.setTextSelection({ from: 1, to: 7 })
    expect(editor.state.selection.empty).toBe(false)
    expect(isNodeSelection(editor.state.selection)).toBe(false)

    editor.chain().focus().setExcalidraw().run()

    const types = editor.getJSON().content?.map((n) => n.type)
    // 替换选中文本段落为画布
    expect(types).toEqual(["excalidraw", "paragraph"])
  })

  it("11. 插入后单次撤销（Undo）：完全恢复至插入前状态与内容", () => {
    const editor = makeEditor(
      '<p>前置段落</p><img src="/test.png" alt="测试图片"><p>后置段落</p>'
    )
    selectFirstNodeOfType(editor, "image")
    const htmlBefore = editor.getHTML()

    editor.chain().focus().setExcalidraw().run()
    expect(editor.getHTML()).not.toBe(htmlBefore)

    editor.commands.undo()
    expect(editor.getHTML()).toBe(htmlBefore)
  })

  it("12. 分割线在 NodeSelection 下保留原节点并在其后插入", () => {
    const editor = makeEditor(
      '<p>前置</p><img src="/test.png" alt="测试图片"><p>后置</p>'
    )
    selectFirstNodeOfType(editor, "image")

    editor.chain().focus().setHorizontalRule().run()

    expect(editor.getJSON().content?.map((n) => n.type)).toEqual([
      "paragraph",
      "image",
      "horizontalRule",
      "paragraph"
    ])
    expect(editor.getJSON().content?.[1].attrs?.src).toBe("/test.png")
  })
})
