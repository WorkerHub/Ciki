/**
 * 服务端把 TipTap JSON 渲染成 HTML（规格 §12.1）。
 *
 * 导入接口只收 `contentJson`，`contentHtml` 必须由服务端生成之后才谈得上消毒
 * （插件侧的 HTML 不可信）。渲染是「按扩展集建 schema → ProseMirror 的 DOMSerializer
 * 序列化」，也就是 `@tiptap/html` 的 generateHTML 内部那一步，不手搓序列化。
 *
 * 为什么两个 tiptap 入口都不用：
 * - 裸 `@tiptap/html`：v3 用条件导出，Node 条件解析到 `dist/server/index.js`，
 *   Workers 打包器（esbuild 的 workerd / browser 条件）解析到浏览器入口
 *   `dist/index.js`——那里的 generateHTML 一开头就检查 `window`，在 Worker 里必抛
 *   「can only be used in a browser environment」（线上报错就是它）。
 * - `@tiptap/html/server`：Node 条件能跑（单测一直是这条路径），但它内部
 *   `new Window()` 是 happy-dom 的浏览器窗口，构造时要把自己 contextify 进 `vm`
 *   （`vm.createContext` + `Script.runInContext`）；workerd 的 node:vm 只实现了
 *   createContext、没实现 runInContext，于是构造即抛
 *   「The "contextifiedObject" argument must be an vm.Context」（本地 wrangler 实测）。
 * 这里改用 happy-dom 公开的 `GlobalWindow`：它跳过 VM 上下文、只做 DOM，把 document
 * 交给 DOMSerializer，序列化逻辑与 tiptap 的 getHTMLFromFragment 一致。Worker 侧只需
 * 一个 DOM 容器，不需要能执行脚本的浏览器窗口。
 *
 * 前提：Worker 开着 `nodejs_compat`（wrangler.toml 已开）——happy-dom 的模块图里有
 * `buffer` / `url` / `vm` 这些 Node 内置模块的 import，workerd 靠这层兼容解析。
 *
 * document 在 isolate 内建一次反复用（每次渲染写进新的 div 再取 innerHTML，不跨请求
 * 留状态）。
 *
 * 扩展集是 `web/src/editor/extensions.ts` 的服务端镜像，只去掉渲染层才需要的东西
 * （NodeView、Placeholder、lowlight）：基础 codeBlock 已输出 `language-*` 类，
 * 与 §4 消毒白名单一致。
 */
import {
  Extension,
  getSchema,
  type Extensions,
  type JSONContent
} from "@tiptap/core"
import {
  DOMSerializer,
  Node as ProseMirrorNode,
  type DOMOutputSpec,
  type Schema
} from "@tiptap/pm/model"
import Highlight from "@tiptap/extension-highlight"
import Image from "@tiptap/extension-image"
import Link from "@tiptap/extension-link"
import { Table } from "@tiptap/extension-table"
import TableCell from "@tiptap/extension-table-cell"
import TableHeader from "@tiptap/extension-table-header"
import TableRow from "@tiptap/extension-table-row"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import { TextStyle } from "@tiptap/extension-text-style"
import Underline from "@tiptap/extension-underline"
import StarterKit from "@tiptap/starter-kit"
import { GlobalWindow } from "happy-dom"

/** 内容无法按编辑器 schema 渲染（未知节点/属性、结构不合法）。 */
export class TiptapRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TiptapRenderError"
  }
}

/**
 * 图片：额外两个属性承载「未转存」标记（契约 §三 图片白名单同名），
 * 与 web 的 WikiImage 一致——这样含占位图的内容经服务端渲染还能还原成占位。
 * width 同口径：只输出正整数像素（与 web 的 imageWidth 同一规则），
 * 非整数值（如脏 JSON 里的 "50%"）不输出，回退自然尺寸。
 */
const ImportImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        // 与 web 的 imageWidth（web/src/editor/image-attributes.ts）逐条同口径：
        // 只认正整数像素——字符串必须是纯数字，布尔/数组/小数串一律丢弃，
        // 不猜用户意图（否则 width:true 会被 Number() 强转成 1）。
        renderHTML: (attributes) => {
          const raw = attributes.width
          const value =
            typeof raw === "string" && /^\d+$/.test(raw.trim())
              ? Number(raw)
              : raw
          if (typeof value !== "number" || !Number.isFinite(value)) return {}
          const width = Math.round(value)
          return width > 0 ? { width: String(width) } : {}
        }
      },
      originalSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-original-src"),
        renderHTML: (attributes) =>
          attributes.originalSrc
            ? { "data-original-src": attributes.originalSrc }
            : {}
      },
      confluenceImg: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-confluence-img"),
        renderHTML: (attributes) =>
          attributes.confluenceImg ? { "data-confluence-img": "true" } : {}
      }
    }
  },
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "img[data-original-src]" }]
  }
})

/**
 * 任务项：勾选态必须落成 `data-checked="true"|"false"` 字符串——§4 白名单只认这
 * 两个值，布尔属性一旦被序列化成裸属性（`data-checked`）就在消毒时整段剥掉。
 * 原生 TaskItem 的 renderHTML 给的是布尔值，happy-dom 目前会 String() 成
 * "true"/"false"（与这里一致）；显式字符串化后输出不再依赖 DOM shim 的属性细节。
 */
const ImportTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => {
          const value = element.getAttribute("data-checked")
          return value === "" || value === "true"
        },
        renderHTML: (attributes) => ({
          "data-checked": attributes.checked ? "true" : "false"
        })
      }
    }
  }
})

/**
 * 颜色：与 web 侧同一套 data 载具（`data-text-color` / `data-color` / `data-cell-bg`）。
 *
 * 为什么不用 TipTap 原生 Color：它只把颜色写进 `style`，而 §4 白名单对 `span` 只留
 * `data-text-color`、`style` 一律剥掉——那样导入路径的颜色就没了，编辑/粘贴/导入三路
 * 也不一致。这里只换「序列化成什么属性」，mark 与命令仍由原生扩展提供。
 */
const ImportColor = Extension.create({
  name: "color",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          color: {
            default: null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.color ? { "data-text-color": attributes.color } : {}
          }
        }
      }
    ]
  }
})

/** 单元格底色：与 web 侧 WikiTableCell/WikiTableHeader 同名同形，只渲染 data 载具。 */
function backgroundColorAttribute() {
  return {
    backgroundColor: {
      default: null,
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.backgroundColor
          ? { "data-cell-bg": attributes.backgroundColor }
          : {}
    }
  }
}

const ImportTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColorAttribute() }
  }
})

const ImportTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundColorAttribute() }
  }
})

/**
 * 表格：原生 Table 把 `colwidth` 渲染成 `col` 的内联 `style`（`dom.style.cssText`），
 * 能不能留下来取决于 DOM 实现的 CSSOM。这里把列宽改写成 HTML 自带的 `col[width]`
 * （等价的像素宽度，§4 白名单同样允许），列宽比例不受 DOM shim 影响。
 * 表格自身的 style 只是 `width`/`min-width` 的宽度提示（白名单对 `table` 只收
 * `min-width`），列宽已在 `col[width]` 上，删掉不影响内容。
 */
function tableColWidthsAsAttributes(spec: unknown): unknown {
  if (!Array.isArray(spec)) return spec
  const [tag, attrs, ...children] = spec
  let nextAttrs = attrs
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    const record = { ...(attrs as Record<string, unknown>) }
    if (tag === "col" && typeof record.style === "string") {
      const width = /^width:\s*(\d+(?:\.\d+)?)(px|%)?$/.exec(record.style)
      if (width) record.width = width[1]
      delete record.style
    } else if (tag === "table") {
      delete record.style
    }
    nextAttrs = record
  }
  return [tag, nextAttrs, ...children.map(tableColWidthsAsAttributes)]
}

const ImportTable = Table.extend({
  renderHTML(input) {
    // Table 自带 renderHTML，parent 一定存在（可选链只是 tiptap 的类型签名）。
    const rendered = this.parent?.(input)
    return tableColWidthsAsAttributes(rendered) as DOMOutputSpec
  }
})

const extensions: Extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
  Underline,
  TextStyle,
  ImportColor,
  Highlight.configure({ multicolor: true }),
  Link.configure({
    autolink: true,
    HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" }
  }),
  ImportImage.configure({ allowBase64: true, inline: false }),
  // 始终包一层 .tableWrapper：读态超宽表格要横向滚动（与 web 一致）。
  ImportTable.configure({ renderWrapper: true }),
  TableRow,
  ImportTableHeader,
  ImportTableCell,
  TaskList,
  ImportTaskItem.configure({ nested: true })
]

/** schema 与序列化器都只取决于扩展集，isolate 内建一次即可。 */
let cachedSchema: Schema | null = null
let cachedSerializer: DOMSerializer | null = null

/**
 * 序列化用的 document：happy-dom 的 `GlobalWindow`（跳过 VM 上下文，见文件头）。
 * 类型直接取 happy-dom 自己的 Document，worker 没有 DOM lib 的全局 Document。
 */
type SerializerDocument = InstanceType<typeof GlobalWindow>["document"]

let cachedDocument: SerializerDocument | null = null

function schema(): Schema {
  if (!cachedSchema) cachedSchema = getSchema(extensions)
  return cachedSchema
}

function serializer(): DOMSerializer {
  if (!cachedSerializer) cachedSerializer = DOMSerializer.fromSchema(schema())
  return cachedSerializer
}

function serializerDocument(): SerializerDocument {
  if (!cachedDocument) {
    const window = new GlobalWindow({
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
        disableCSSFileLoading: true,
        disableIframePageLoading: true,
        disableComputedStyleRendering: true
      }
    })
    cachedDocument = window.document
  }
  return cachedDocument
}

/** 序列化进一个临时 div 再取 innerHTML（与 tiptap 的 getHTMLFromFragment 同一做法）。 */
function serialize(node: ProseMirrorNode): string {
  const document = serializerDocument()
  const wrap = document.createElement("div")
  serializer().serializeFragment(node.content, { document }, wrap)
  return wrap.innerHTML
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 结构上限：防止病态的深嵌套把递归校验打爆栈。 */
const MAX_DEPTH = 100

function validateAttrs(
  declared: Record<string, unknown> | undefined,
  attrs: unknown,
  label: string
): void {
  if (attrs === undefined || attrs === null) return
  if (!isPlainObject(attrs)) {
    throw new TiptapRenderError(`${label} attrs must be an object`)
  }
  const allowed = new Set(Object.keys(declared ?? {}))
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) {
      throw new TiptapRenderError(`Unknown attribute "${key}" on ${label}`)
    }
  }
}

/**
 * 按 schema 校验 JSON：未知节点 / 未知 mark / 未声明属性一律拒绝，
 * 让插件侧拼错的内容在 400 里显形，而不是被静默丢掉属性后落库。
 */
function validateContent(
  docSchema: Schema,
  value: unknown,
  path: string,
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    throw new TiptapRenderError(`${path} is nested too deeply`)
  }
  if (!isPlainObject(value)) {
    throw new TiptapRenderError(`${path} must be an object`)
  }
  if (typeof value.type !== "string") {
    throw new TiptapRenderError(`${path}.type must be a string`)
  }
  const nodeType = docSchema.nodes[value.type]
  if (!nodeType) {
    throw new TiptapRenderError(`Unknown node type: ${value.type}`)
  }
  validateAttrs(nodeType.spec.attrs, value.attrs, `node "${value.type}"`)

  if (value.text !== undefined && typeof value.text !== "string") {
    throw new TiptapRenderError(`${path}.text must be a string`)
  }

  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks)) {
      throw new TiptapRenderError(`${path}.marks must be an array`)
    }
    for (const mark of value.marks) {
      if (!isPlainObject(mark) || typeof mark.type !== "string") {
        throw new TiptapRenderError(`${path}.marks[] must have a type`)
      }
      const markType = docSchema.marks[mark.type]
      if (!markType) {
        throw new TiptapRenderError(`Unknown mark type: ${mark.type}`)
      }
      validateAttrs(markType.spec.attrs, mark.attrs, `mark "${mark.type}"`)
    }
  }

  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) {
      throw new TiptapRenderError(`${path}.content must be an array`)
    }
    value.content.forEach((child, index) => {
      validateContent(docSchema, child, `${path}.content[${index}]`, depth + 1)
    })
  }
}

/**
 * TipTap JSON → HTML 字符串。结构不合法时抛 TiptapRenderError（路由转 400）。
 * 输出的 HTML 仍是「原样渲染」的结果，安全边界在 lib/sanitize.ts。
 */
export function renderTiptapHtml(json: unknown): string {
  if (!isPlainObject(json) || json.type !== "doc") {
    throw new TiptapRenderError("contentJson must be a doc node")
  }
  const docSchema = schema()
  try {
    validateContent(docSchema, json, "doc", 0)
    return serialize(ProseMirrorNode.fromJSON(docSchema, json as JSONContent))
  } catch (err) {
    if (err instanceof TiptapRenderError) throw err
    throw new TiptapRenderError(
      err instanceof Error ? err.message : "contentJson cannot be rendered"
    )
  }
}
