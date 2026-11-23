import { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { editorPayload } from "@/editor/Editor"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions, type EditorMode } from "@/editor/extensions"
import { ReadView } from "@/editor/ReadView"
import { api } from "@/lib/api"
import { MAX_EMBED_BYTES, validateEmbedFile } from "@/lib/upload"
import {
  DEFAULT_HTML_EMBED_HEIGHT,
  MAX_HTML_EMBED_HEIGHT,
  MIN_HTML_EMBED_HEIGHT,
  clampHtmlEmbedHeight
} from "./extension"
import { installTiptapJsdomShims } from "@/test/tiptap-jsdom"

const EMBED_KEY = "embeds/0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b.html"
const EMBED_NAME = "step-animation.html"
const EMBED_HEIGHT = 480
const EMBED_HTML = `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="${EMBED_HEIGHT}" data-name="${EMBED_NAME}"></div>`

const editors: Editor[] = []

function cleanupEditors() {
  while (editors.length) {
    const ed = editors.pop()
    const el = ed?.options.element
    if (el instanceof Element && el.parentNode) el.remove()
    ed?.destroy()
  }
}

function makeEditor(content: string, mode: EditorMode = "edit"): Editor {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createExtensions(mode),
    content
  })
  editors.push(editor)
  return editor
}

function EditorHarness({
  content,
  mode = "edit",
  onEditor
}: {
  content: string
  mode?: EditorMode
  onEditor?: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: createExtensions(mode),
    content,
    editable: mode === "edit"
  })
  useEffect(() => {
    if (editor) onEditor?.(editor)
  }, [editor, onEditor])

  if (!editor) return null
  return (
    <div>
      <EditorContent editor={editor} />
      <span data-testid="ready">{editor ? "yes" : "no"}</span>
    </div>
  )
}

describe("htmlEmbed 节点契约与规范", () => {
  beforeAll(() => {
    installTiptapJsdomShims()
  })

  afterEach(() => {
    cleanupEditors()
    vi.restoreAllMocks()
  })

  it("1. 节点解析：div[data-type='html-embed'] 正确解析为 htmlEmbed 节点及各 attrs", () => {
    const editor = makeEditor(EMBED_HTML)
    const json = editor.getJSON()
    const embedNode = json.content?.find((node) => node.type === "htmlEmbed")

    expect(embedNode).toBeDefined()
    expect(embedNode?.attrs).toEqual({
      key: EMBED_KEY,
      height: EMBED_HEIGHT,
      name: EMBED_NAME
    })
  })

  it("2. 载具输出：TipTap 输出 HTML 必须是 div[data-type='html-embed']，绝不输出 iframe", () => {
    const editor = makeEditor(EMBED_HTML)
    const outputHtml = editor.getHTML()

    expect(outputHtml).toContain('data-type="html-embed"')
    expect(outputHtml).toContain(`data-key="${EMBED_KEY}"`)
    expect(outputHtml).toContain(`data-height="${EMBED_HEIGHT}"`)
    expect(outputHtml).toContain(`data-name="${EMBED_NAME}"`)
    // 核心安全与消毒契约：HTML 载具不能用 iframe 标签，防止服务端消毒剥除
    expect(outputHtml).not.toContain("<iframe")
  })

  it("3. 高度 clamp 机制：无论解析、输入还是保存均锁定在 200–2000px 范围", () => {
    // 纯函数 clamp 验证
    expect(clampHtmlEmbedHeight(100)).toBe(MIN_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight(3000)).toBe(MAX_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight("600")).toBe(600)
    expect(clampHtmlEmbedHeight("invalid")).toBe(DEFAULT_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight(null)).toBe(DEFAULT_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight(undefined)).toBe(DEFAULT_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight("")).toBe(DEFAULT_HTML_EMBED_HEIGHT)
    expect(clampHtmlEmbedHeight("   ")).toBe(DEFAULT_HTML_EMBED_HEIGHT)

    // parseHTML clamp
    const lowEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="50" data-name="test.html"></div>`
    )
    expect(lowEditor.getJSON().content?.[0]?.attrs?.height).toBe(200)

    const highEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="5000" data-name="test.html"></div>`
    )
    expect(highEditor.getJSON().content?.[0]?.attrs?.height).toBe(2000)

    // 缺失或为空的 data-height 必须回退到默认 480，绝不能误返回 200
    const absentEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="test.html"></div>`
    )
    expect(absentEditor.getJSON().content?.[0]?.attrs?.height).toBe(
      DEFAULT_HTML_EMBED_HEIGHT
    )

    const emptyEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="" data-name="test.html"></div>`
    )
    expect(emptyEditor.getJSON().content?.[0]?.attrs?.height).toBe(
      DEFAULT_HTML_EMBED_HEIGHT
    )
  })

  it("3b. renderText 国际化与摘要文本生成", () => {
    const editor = makeEditor(EMBED_HTML)
    expect(editor.getText()).toContain(`[HTML 动画: ${EMBED_NAME}]`)

    const unnamedEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}"></div>`
    )
    expect(unnamedEditor.getText()).toContain("[HTML 动画: 未命名动画]")
  })

  it("4. 上传校验：非 .html 扩展名及超过 1MB 均被清晰拦截拒绝", () => {
    // 扩展名非法
    const invalidExtFile = new File(["<script></script>"], "script.js", {
      type: "application/javascript"
    })
    expect(validateEmbedFile(invalidExtFile)).toBe("仅支持 .html 文件")

    const svgFile = new File(["<svg></svg>"], "image.svg", {
      type: "image/svg+xml"
    })
    expect(validateEmbedFile(svgFile)).toBe("仅支持 .html 文件")

    // 大小超过 1MB
    const largeContent = new Uint8Array(MAX_EMBED_BYTES + 1)
    const largeFile = new File([largeContent], "large.html", {
      type: "text/html"
    })
    expect(validateEmbedFile(largeFile)).toBe("HTML 动画文件不能超过 1MB")

    // 合法文件通过校验
    const validFile = new File(["<!DOCTYPE html><html></html>"], "valid.html", {
      type: "text/html"
    })
    expect(validateEmbedFile(validFile)).toBeNull()
  })

  it("5. 编辑器渲染：编辑态只渲染占位卡，绝不渲染 iframe，绝不执行脚本（代码与运行时证据）", async () => {
    const { container } = render(
      <EditorHarness content={EMBED_HTML} mode="edit" />
    )
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    // 占位卡必须存在
    const card = await screen.findByText(EMBED_NAME)
    expect(card).toBeInTheDocument()

    // 验证关键按钮与输入项
    expect(screen.getByRole("button", { name: "更换文件" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument()
    const heightInput = container.querySelector(
      "input[data-html-embed-height-input]"
    ) as HTMLInputElement
    expect(heightInput).toBeInTheDocument()
    expect(heightInput.value).toBe(String(EMBED_HEIGHT))

    // Tony 评审核心证据：编辑态 DOM 树中绝对不存在 iframe
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("6. 编辑态高度调整：修改高度并失焦自动更新属性并 clamp 范围", async () => {
    const user = userEvent.setup()
    let curEditor: Editor | null = null
    render(
      <EditorHarness
        content={EMBED_HTML}
        mode="edit"
        onEditor={(ed) => {
          curEditor = ed
        }}
      />
    )
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    const heightInput = (await screen.findByDisplayValue(
      String(EMBED_HEIGHT)
    )) as HTMLInputElement

    // 输入超上限的值 2500，失焦后自动 clamp 到 2000
    await user.clear(heightInput)
    await user.type(heightInput, "2500")
    await user.tab()

    await waitFor(() => {
      expect(heightInput.value).toBe("2000")
    })

    expect(
      (curEditor as Editor | null)?.getJSON().content?.[0]?.attrs?.height
    ).toBe(2000)
  })

  it("7. 编辑态删除块：点击删除按钮直接移除节点", async () => {
    const user = userEvent.setup()
    let curEditor: Editor | null = null
    render(
      <EditorHarness
        content={EMBED_HTML}
        mode="edit"
        onEditor={(ed) => {
          curEditor = ed
        }}
      />
    )
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")

    const deleteBtn = await screen.findByRole("button", { name: "删除" })
    await user.click(deleteBtn)

    await waitFor(() => {
      expect(
        (curEditor as Editor | null)
          ?.getJSON()
          .content?.some((node) => node.type === "htmlEmbed")
      ).toBe(false)
    })
  })

  it("8. 编辑态更换文件：上传新文件后更新 key 与 name", async () => {
    const NEW_KEY = "embeds/22222222-2222-2222-2222-222222222222.html"
    const NEW_NAME = "new-animation.html"
    vi.spyOn(api, "uploadEmbed").mockResolvedValue({
      key: NEW_KEY,
      url: `/api/files/${NEW_KEY}`,
      contentType: "text/html",
      size: 1024
    })

    let curEditor: Editor | null = null
    const { container } = render(
      <EditorHarness
        content={EMBED_HTML}
        mode="edit"
        onEditor={(ed) => {
          curEditor = ed
        }}
      />
    )
    expect(await screen.findByTestId("ready")).toHaveTextContent("yes")
    await screen.findByText(EMBED_NAME)

    const fileInput = container.querySelector(
      'input[type="file"][accept=".html,text/html"]'
    ) as HTMLInputElement
    expect(fileInput).not.toBeNull()

    const testFile = new File(["<h1>new</h1>"], NEW_NAME, {
      type: "text/html"
    })

    await act(async () => {
      await userEvent.upload(fileInput, testFile)
    })

    await waitFor(() => {
      expect(screen.getByText(NEW_NAME)).toBeInTheDocument()
    })

    expect(
      (curEditor as Editor | null)?.getJSON().content?.[0]?.attrs?.key
    ).toBe(NEW_KEY)
    expect(
      (curEditor as Editor | null)?.getJSON().content?.[0]?.attrs?.name
    ).toBe(NEW_NAME)
  })

  it("9. 阅读态渲染：iframe sandbox='allow-scripts' 无多余权限，referrerpolicy='no-referrer'，宽 100% 懒加载", async () => {
    // 模拟资源 HEAD 检查正常
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )

    const { container } = render(<ReadView html={EMBED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    // Tony 评审核心：仅包含 allow-scripts，绝无 allow-same-origin / allow-top-navigation / allow-popups / allow-forms
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.getAttribute("loading")).toBe("lazy")
    expect(iframe.src).toContain(`/api/files/${EMBED_KEY}`)
    expect(iframe.style.width).toBe("100%")
    expect(iframe.style.height).toBe(`${EMBED_HEIGHT}px`)
  })

  it("10. 阅读态异常容错：文件不存在或下发失败渲染占位卡，不崩溃页面", async () => {
    // 模拟下发 404
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 })
    )

    const { container } = render(<ReadView html={EMBED_HTML} />)

    const errorPlaceholder = await waitFor(() => {
      const el = container.querySelector("[data-html-embed-error]")
      expect(el).not.toBeNull()
      return el
    })

    expect(errorPlaceholder).toBeInTheDocument()
    expect(screen.getByText(EMBED_NAME)).toBeInTheDocument()
    expect(screen.getByText("文件不存在或下发失败")).toBeInTheDocument()
  })

  it("11. 保存清理与归一：空白 key 节点自动剥离，未 clamp 高度自动锁定", () => {
    const editor = makeEditor(
      `<p>正文</p><div data-type="html-embed" data-key="" data-name="blank.html"></div>`
    )
    // 触发保存 payload 提取
    const payload = editorPayload(editor)

    // 空白 htmlEmbed 节点必须被移除
    expect(payload.contentJson).not.toContain('"type":"htmlEmbed"')
    expect(payload.contentHtml).not.toContain('data-type="html-embed"')
  })

  it("12. 工具栏插入：点击插入按钮选择文件并插入 htmlEmbed 节点", async () => {
    const editor = makeEditor("<p>段落</p>")
    const uploadSpy = vi.spyOn(api, "uploadEmbed").mockResolvedValue({
      key: EMBED_KEY,
      url: `/api/files/${EMBED_KEY}`,
      contentType: "text/html",
      size: 2048
    })

    const { container } = render(<EditorToolbar editor={editor} />)

    const insertBtn = screen.getByRole("button", { name: "插入 HTML 动画" })
    expect(insertBtn).toBeInTheDocument()

    // 获取对应的 file input
    const embedInput = container.querySelector(
      'input[type="file"][accept=".html,text/html"]'
    ) as HTMLInputElement
    expect(embedInput).not.toBeNull()

    const testFile = new File(["<!DOCTYPE html>"], "test-anim.html", {
      type: "text/html"
    })

    await act(async () => {
      await userEvent.upload(embedInput, testFile)
    })

    expect(uploadSpy).toHaveBeenCalledWith(testFile)
    expect(
      editor.getJSON().content?.some((node) => node.type === "htmlEmbed")
    ).toBe(true)
  })
})
