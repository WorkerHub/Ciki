/**
 * 服务端把 TipTap JSON 渲染成 HTML（规格 §12.1）。
 *
 * 导入接口只收 `contentJson`，`contentHtml` 必须由服务端生成之后才谈得上消毒
 * （插件侧的 HTML 不可信）。渲染走官方 `@tiptap/html` 的 generateHTML 管线
 * （内部用 zeed-dom，无 DOM 依赖，Workers 可用），不手搓序列化。
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
import { generateHTML } from "@tiptap/html"
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
import type { DOMOutputSpec, Schema } from "@tiptap/pm/model"

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
 */
const ImportImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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
 * 任务项：zeed-dom 会把布尔属性序列化成裸属性（`data-checked`），而 §4 白名单
 * 只认 `data-checked="true"|"false"`——不转成字符串，勾选态会在消毒时被剥掉。
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
 * 为什么不用 TipTap 原生 Color：它只把颜色写进 `style`，而 zeed-dom 会整段丢 style——
 * 那样导入路径的颜色就没了。这里只换「序列化成什么属性」，mark 与命令仍由原生扩展提供。
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
 * 表格：ProseMirror 对 `style` 走 `dom.style.cssText`，而 zeed-dom 的 style 是
 * 只读快照，写进去就丢——`@tiptap/html` + zeed-dom 下表格列宽会整段消失。
 * 这里把列宽改写成 HTML 自带的 `col[width]`（等价的像素宽度，且 §4 白名单允许），
 * 列宽比例不丢；表格自身的 `min-width` 只是横向滚动提示，不影响内容。
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

/** schema 只取决于扩展集，isolate 内建一次即可。 */
let cachedSchema: Schema | null = null

function schema(): Schema {
  if (!cachedSchema) cachedSchema = getSchema(extensions)
  return cachedSchema
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
    return generateHTML(json as JSONContent, extensions)
  } catch (err) {
    if (err instanceof TiptapRenderError) throw err
    throw new TiptapRenderError(
      err instanceof Error ? err.message : "contentJson cannot be rendered"
    )
  }
}
