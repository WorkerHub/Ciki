import { Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { editorPayload } from "@/editor/Editor"
import { EditorToolbar } from "@/editor/EditorToolbar"
import { createExtensions, type EditorMode } from "@/editor/extensions"
import { ReadView } from "@/editor/ReadView"
import { api } from "@/lib/api"
import { MAX_EMBED_BYTES, validateEmbedFile } from "@/lib/upload"
import { useThemeStore } from "@/stores/theme"
import {
  DEFAULT_HTML_EMBED_HEIGHT,
  MAX_HTML_EMBED_AUTO_HEIGHT,
  MAX_HTML_EMBED_MANUAL_HEIGHT,
  MIN_HTML_EMBED_AUTO_HEIGHT,
  MIN_HTML_EMBED_MANUAL_HEIGHT,
  clampAutoHtmlEmbedHeight,
  clampHtmlEmbedHeight,
  clampManualHtmlEmbedHeight
} from "./extension"
import {
  CIKI_EMBED_HEIGHT_MESSAGE_TYPE,
  CIKI_EMBED_THEME_MESSAGE_TYPE
} from "./types"
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
    useThemeStore.getState().setTheme("auto")
    useThemeStore.getState().setStyle("nova")
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

    // 未指定 data-height 时解析为 null（自动贴合）
    const autoEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="${EMBED_NAME}"></div>`
    )
    expect(autoEditor.getJSON().content?.[0]?.attrs?.height).toBeNull()
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

    // 当 height 为 null 时，输出 HTML 不包含 data-height 属性
    const autoEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="${EMBED_NAME}"></div>`
    )
    const autoHtml = autoEditor.getHTML()
    expect(autoHtml).toContain('data-type="html-embed"')
    expect(autoHtml).not.toContain("data-height")
  })

  it("3. 高度 clamp 机制：手填值 clamp 200–2000（为空返回 null），自动贴合上报 clamp 200–4000", () => {
    // 手填 clamp 纯函数验证：有效数字锁定在 200–2000px，为空/非法值返回 null（自动模式）
    expect(clampManualHtmlEmbedHeight(100)).toBe(MIN_HTML_EMBED_MANUAL_HEIGHT)
    expect(clampManualHtmlEmbedHeight(3000)).toBe(MAX_HTML_EMBED_MANUAL_HEIGHT)
    expect(clampManualHtmlEmbedHeight("600")).toBe(600)
    expect(clampManualHtmlEmbedHeight("invalid")).toBeNull()
    expect(clampManualHtmlEmbedHeight(null)).toBeNull()
    expect(clampManualHtmlEmbedHeight(undefined)).toBeNull()
    expect(clampManualHtmlEmbedHeight("")).toBeNull()
    expect(clampManualHtmlEmbedHeight("   ")).toBeNull()
    expect(clampHtmlEmbedHeight("500")).toBe(500)

    // 自动贴合上报 clamp 纯函数验证：锁定在 200–4000px
    expect(clampAutoHtmlEmbedHeight(100)).toBe(MIN_HTML_EMBED_AUTO_HEIGHT)
    expect(clampAutoHtmlEmbedHeight(5000)).toBe(MAX_HTML_EMBED_AUTO_HEIGHT)
    expect(clampAutoHtmlEmbedHeight(1200)).toBe(1200)
    expect(clampAutoHtmlEmbedHeight("invalid")).toBe(DEFAULT_HTML_EMBED_HEIGHT)

    // parseHTML 手填 clamp
    const lowEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="50" data-name="test.html"></div>`
    )
    expect(lowEditor.getJSON().content?.[0]?.attrs?.height).toBe(200)

    const highEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="5000" data-name="test.html"></div>`
    )
    expect(highEditor.getJSON().content?.[0]?.attrs?.height).toBe(2000)

    // 缺失或为空的 data-height 解析为 null（自动贴合），不回退到 200，支持可空
    const absentEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="test.html"></div>`
    )
    expect(absentEditor.getJSON().content?.[0]?.attrs?.height).toBeNull()

    const emptyEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="" data-name="test.html"></div>`
    )
    expect(emptyEditor.getJSON().content?.[0]?.attrs?.height).toBeNull()

    // 存量已填高度的节点保持固定数值、不做数据迁移
    const existingEditor = makeEditor(
      `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="480" data-name="test.html"></div>`
    )
    expect(existingEditor.getJSON().content?.[0]?.attrs?.height).toBe(480)
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

  it("6. 编辑态高度调整：修改高度并失焦自动更新属性并 clamp 范围，清空高度输入自动转为 null（自动贴合）", async () => {
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

    // 1. 输入超上限的值 2500，失焦后自动 clamp 到 2000
    await user.clear(heightInput)
    await user.type(heightInput, "2500")
    await user.tab()

    await waitFor(() => {
      expect(heightInput.value).toBe("2000")
    })

    expect(
      (curEditor as Editor | null)?.getJSON().content?.[0]?.attrs?.height
    ).toBe(2000)

    // 2. 清空高度输入，失焦后节点 attrs.height 变为 null（自动贴合模式），输入框 placeholder 显示「自动」
    await user.clear(heightInput)
    await user.tab()

    await waitFor(() => {
      expect(heightInput.value).toBe("")
    })

    expect(heightInput.placeholder).toBe("自动")
    expect(
      (curEditor as Editor | null)?.getJSON().content?.[0]?.attrs?.height
    ).toBeNull()
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

  it("9b. 阅读态自动贴合：未填高度时初始默认高度，接收 ciki-embed-height 消息自动贴合高度并跟随动态变高", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )

    // 未填高度样例（自动贴合）
    const AUTO_EMBED_HTML = `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="${EMBED_NAME}"></div>`
    const { container } = render(<ReadView html={AUTO_EMBED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    // 初始高度为默认 480px
    expect(iframe.style.height).toBe(`${DEFAULT_HTML_EMBED_HEIGHT}px`)

    // ① 未填高度样例收到合法的 ciki-embed-height 消息自动贴合（例如 350px）
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 350 }
        })
      )
    })

    await waitFor(() => {
      expect(iframe.style.height).toBe("350px")
    })

    // ② 内容动态变高跟随（例如展开后变更为 1200px）
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 1200 }
        })
      )
    })

    await waitFor(() => {
      expect(iframe.style.height).toBe("1200px")
    })

    // ③ 内容动态变矮收缩（例如收起后变更为 273px 矮样例，向下贴合）
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 273 }
        })
      )
    })

    await waitFor(() => {
      expect(iframe.style.height).toBe("273px")
    })
  })

  it("9c. 恶意消息防护与自动贴合双钳制（200–4000）：非 contentWindow 来源丢弃、乱发协议丢弃、超限高度钳制", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )

    const AUTO_EMBED_HTML = `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="${EMBED_NAME}"></div>`
    const { container } = render(<ReadView html={AUTO_EMBED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    // 先贴合到 500px 基线
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 500 }
        })
      )
    })
    await waitFor(() => {
      expect(iframe.style.height).toBe("500px")
    })

    // 1. 来源校验：若 event.source 不是本 iframe.contentWindow（例如主窗口或伪造来源），严格忽略
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 1000 }
        })
      )
    })
    expect(iframe.style.height).toBe("500px")

    // 2. 协议校验：只处理 ciki-embed-height 一种消息，其余恶意/乱发类型直接丢弃
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "malicious-eval", code: "alert(1)", height: 800 }
        })
      )
    })
    expect(iframe.style.height).toBe("500px")

    // 3. 数值校验：非数字或 NaN 乱发直接丢弃
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: "not-a-number" }
        })
      )
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: NaN }
        })
      )
    })
    expect(iframe.style.height).toBe("500px")

    // 4. 恶意狂发超大值（如 999999）：自动模式钳制到上限 4000px
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 999999 }
        })
      )
    })
    await waitFor(() => {
      expect(iframe.style.height).toBe(`${MAX_HTML_EMBED_AUTO_HEIGHT}px`)
    })

    // 5. 恶意狂发超小值（如 10）：自动模式钳制到下限 200px
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 10 }
        })
      )
    })
    await waitFor(() => {
      expect(iframe.style.height).toBe(`${MIN_HTML_EMBED_AUTO_HEIGHT}px`)
    })
  })

  it("9d. ③ 填固定高度仍固定：固定高度路径不受上报干扰", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )

    // 填固定高度 600px 的节点
    const FIXED_HTML = `<div data-type="html-embed" data-key="${EMBED_KEY}" data-height="600" data-name="${EMBED_NAME}"></div>`
    const { container } = render(<ReadView html={FIXED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    expect(iframe.style.height).toBe("600px")

    // iframe 发送高度上报消息，因节点处于固定模式，严格忽略上报值
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: CIKI_EMBED_HEIGHT_MESSAGE_TYPE, height: 350 }
        })
      )
    })

    // 高度依然稳固保持在 600px
    expect(iframe.style.height).toBe("600px")
  })

  it("11. 保存清理与归一：空白 key 节点自动剥离，手填未 clamp 高度自动锁定 200–2000，为空保持 null", () => {
    const editor = makeEditor(
      `<p>正文</p><div data-type="html-embed" data-key="" data-name="blank.html"></div>`
    )
    // 触发保存 payload 提取
    const payload = editorPayload(editor)

    // 空白 htmlEmbed 节点必须被移除
    expect(payload.contentJson).not.toContain('"type":"htmlEmbed"')
    expect(payload.contentHtml).not.toContain('data-type="html-embed"')

    // 手填超出 2000 的高度在保存前规范化为 2000
    const highEditor = makeEditor(
      `<p>正文</p><div data-type="html-embed" data-key="${EMBED_KEY}" data-height="3000" data-name="test.html"></div>`
    )
    const highPayload = editorPayload(highEditor)
    expect(highPayload.contentJson).toContain('"height":2000')

    // 未填高度（自动贴合）在保存前保持 null，生成的 contentHtml 不带 data-height
    const autoEditor = makeEditor(
      `<p>正文</p><div data-type="html-embed" data-key="${EMBED_KEY}" data-name="test.html"></div>`
    )
    const autoPayload = editorPayload(autoEditor)
    expect(autoPayload.contentJson).toContain('"height":null')
    expect(autoPayload.contentHtml).not.toContain("data-height")
  })

  it("12. 工具栏插入：点击插入按钮选择文件并插入 htmlEmbed 节点，默认留空（null，自动贴合）", async () => {
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
    const embedNode = editor
      .getJSON()
      .content?.find((node) => node.type === "htmlEmbed")
    expect(embedNode).toBeDefined()
    expect(embedNode?.attrs?.height).toBeNull()
  })

  it("13. 阅读态主题跟随：iframe src 拼参，load 与主题 store 变化双路下发 ciki-embed-theme", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().setStyle("paper")

    const { container } = render(<ReadView html={EMBED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    // 1. 首帧参数：src 携带 theme=dark 与 style=paper
    expect(iframe.src).toContain("theme=dark")
    expect(iframe.src).toContain("style=paper")

    // Mock contentWindow.postMessage
    const postMessageSpy = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: postMessageSpy },
      configurable: true
    })

    // 2. iframe load 事件触发主题下发
    fireEvent.load(iframe)
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: CIKI_EMBED_THEME_MESSAGE_TYPE,
        theme: "dark",
        style: "paper"
      },
      "*"
    )

    postMessageSpy.mockClear()

    // 3. 主题 store 变化重发：切为 light / nova
    await act(async () => {
      useThemeStore.getState().setTheme("light")
      useThemeStore.getState().setStyle("nova")
    })

    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        {
          type: CIKI_EMBED_THEME_MESSAGE_TYPE,
          theme: "light",
          style: "nova"
        },
        "*"
      )
    })

    // 验证核心（Tony 评审硬指标）：已 load 的 iframe 在主题切换后，src 保持初始参数，绝不触发重新导航（重载）
    expect(iframe.src).toContain("theme=dark")
    expect(iframe.src).toContain("style=paper")
    expect(iframe.src).not.toContain("theme=light")

    // 4. 固定高度与自动高度均下发
    const AUTO_HTML = `<div data-type="html-embed" data-key="${EMBED_KEY}" data-name="${EMBED_NAME}"></div>`
    const { container: autoContainer } = render(<ReadView html={AUTO_HTML} />)
    const autoIframe = await waitFor(() => {
      const el = autoContainer.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })
    const autoPostMessageSpy = vi.fn()
    Object.defineProperty(autoIframe, "contentWindow", {
      value: { postMessage: autoPostMessageSpy },
      configurable: true
    })
    fireEvent.load(autoIframe)
    expect(autoPostMessageSpy).toHaveBeenCalledWith(
      {
        type: CIKI_EMBED_THEME_MESSAGE_TYPE,
        theme: "light",
        style: "nova"
      },
      "*"
    )
  })

  it("14. 同页多个嵌入独立下发主题且互不干扰", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().setStyle("nova")

    const TWO_EMBEDS_HTML = `
      <div data-type="html-embed" data-key="embeds/11111111-1111-1111-1111-111111111111.html" data-name="first.html"></div>
      <div data-type="html-embed" data-key="embeds/22222222-2222-2222-2222-222222222222.html" data-name="second.html"></div>
    `
    const { container } = render(<ReadView html={TWO_EMBEDS_HTML} />)

    const iframes = await waitFor(() => {
      const els = container.querySelectorAll("iframe[data-html-embed-iframe]")
      expect(els.length).toBe(2)
      return Array.from(els) as HTMLIFrameElement[]
    })

    const spy1 = vi.fn()
    const spy2 = vi.fn()
    Object.defineProperty(iframes[0], "contentWindow", {
      value: { postMessage: spy1 },
      configurable: true
    })
    Object.defineProperty(iframes[1], "contentWindow", {
      value: { postMessage: spy2 },
      configurable: true
    })

    fireEvent.load(iframes[0])
    fireEvent.load(iframes[1])

    expect(spy1).toHaveBeenCalledWith(
      {
        type: CIKI_EMBED_THEME_MESSAGE_TYPE,
        theme: "dark",
        style: "nova"
      },
      "*"
    )
    expect(spy2).toHaveBeenCalledWith(
      {
        type: CIKI_EMBED_THEME_MESSAGE_TYPE,
        theme: "dark",
        style: "nova"
      },
      "*"
    )
  })

  it("15. 懒加载边界：iframe 尚未 load 前若主题变化，更新 src 查询参数保证待加载首帧按新主题渲染", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 })
    )
    useThemeStore.getState().setTheme("dark")
    useThemeStore.getState().setStyle("paper")

    const { container } = render(<ReadView html={EMBED_HTML} />)

    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe[data-html-embed-iframe]")
      expect(el).not.toBeNull()
      return el as HTMLIFrameElement
    })

    expect(iframe.src).toContain("theme=dark")

    // 在尚未触发 load 事件前切换主题
    await act(async () => {
      useThemeStore.getState().setTheme("light")
      useThemeStore.getState().setStyle("nova")
    })

    // 未 load 状态下 src 参数更新为最新主题，保证首帧按新主题渲染
    await waitFor(() => {
      expect(iframe.src).toContain("theme=light")
      expect(iframe.src).toContain("style=nova")
    })
  })
})
