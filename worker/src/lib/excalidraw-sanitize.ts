/**
 * Excalidraw 场景 JSON 消毒白名单（写 R2 前预检，依据 #40 冻结契约）。
 *
 * 1. 顶层仅留 type(="excalidraw"), version(=2), source, elements, appState, files(一期置 {})。
 *    剥除 __proto__, constructor 及所有未声明属性。
 * 2. elements[].type 仅放行：rectangle, diamond, ellipse, line, arrow, freedraw, text, frame, magicframe。
 *    严格剥除 embeddable, iframe, image 及未声明类型。
 * 3. 元素属性按几何/样式/文本白名单保留，link 仅许 ^https?:// 或站内 /，剥 javascript:/data:/vbscript:，
 *    customData 一律丢弃。
 * 4. appState 仅留 viewBackgroundColor(hex), gridSize, exportWithDarkMode, exportBackground, exportPadding。
 * 5. files 一期置 {}。
 */

export const ALLOWED_ELEMENT_TYPES = new Set([
  "rectangle",
  "diamond",
  "ellipse",
  "line",
  "arrow",
  "freedraw",
  "text",
  "frame",
  "magicframe"
])

const ALLOWED_GEOMETRY_STYLE_KEYS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "groupIds",
  "frameId",
  "locked",
  "boundElements",
  "points"
] as const

const ALLOWED_TEXT_KEYS = [
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "baseline",
  "lineHeight",
  "containerId",
  "autoResize"
] as const

const SAFE_LINK_RE = /^(?:https?:\/\/|\/(?!\/))/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/

export interface SanitizedExcalidrawScene {
  type: "excalidraw"
  version: 2
  source?: string
  elements: Array<Record<string, unknown>>
  appState: Record<string, unknown>
  files: Record<string, never>
}

/** 深度清理对象中的原型污染键 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (key === "__proto__" || key === "constructor") {
      return undefined
    }
    return value
  })
}

/** 对单个元素按白名单过滤属性 */
export function sanitizeElement(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const el = raw as Record<string, unknown>

  if (typeof el.type !== "string" || !ALLOWED_ELEMENT_TYPES.has(el.type)) {
    return null
  }

  const clean: Record<string, unknown> = {}

  for (const key of ALLOWED_GEOMETRY_STYLE_KEYS) {
    if (key in el && el[key] !== undefined) {
      clean[key] = el[key]
    }
  }

  for (const key of ALLOWED_TEXT_KEYS) {
    if (key in el && el[key] !== undefined) {
      if (key === "fontFamily") {
        if (
          typeof el.fontFamily === "number" &&
          el.fontFamily >= 1 &&
          el.fontFamily <= 5
        ) {
          clean.fontFamily = el.fontFamily
        }
      } else {
        clean[key] = el[key]
      }
    }
  }

  if ("link" in el) {
    if (typeof el.link === "string" && SAFE_LINK_RE.test(el.link)) {
      clean.link = el.link
    } else {
      clean.link = null
    }
  }

  return clean
}

/** 对画布状态 (appState) 过滤 */
export function sanitizeAppState(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const appState = raw as Record<string, unknown>
  const clean: Record<string, unknown> = {}

  if (
    typeof appState.viewBackgroundColor === "string" &&
    HEX_COLOR_RE.test(appState.viewBackgroundColor)
  ) {
    clean.viewBackgroundColor = appState.viewBackgroundColor.toLowerCase()
  }

  if (
    typeof appState.gridSize === "number" &&
    Number.isFinite(appState.gridSize) &&
    appState.gridSize > 0
  ) {
    clean.gridSize = appState.gridSize
  } else if (appState.gridSize === null) {
    clean.gridSize = null
  }

  if (typeof appState.exportWithDarkMode === "boolean") {
    clean.exportWithDarkMode = appState.exportWithDarkMode
  }

  if (typeof appState.exportBackground === "boolean") {
    clean.exportBackground = appState.exportBackground
  }

  if (
    typeof appState.exportPadding === "number" &&
    Number.isFinite(appState.exportPadding)
  ) {
    clean.exportPadding = appState.exportPadding
  }

  return clean
}

/** 对整个场景对象进行预检并消毒 */
export function sanitizeExcalidrawScene(
  raw: unknown
): SanitizedExcalidrawScene | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const scene = raw as Record<string, unknown>

  if (scene.type !== "excalidraw" || scene.version !== 2) {
    return null
  }

  if (!Array.isArray(scene.elements)) {
    return null
  }

  const elements: Array<Record<string, unknown>> = []
  for (const rawEl of scene.elements) {
    const cleanEl = sanitizeElement(rawEl)
    if (cleanEl) {
      elements.push(cleanEl)
    }
  }

  const appState = sanitizeAppState(scene.appState)

  const result: SanitizedExcalidrawScene = {
    type: "excalidraw",
    version: 2,
    elements,
    appState,
    files: {}
  }

  if (typeof scene.source === "string") {
    result.source = scene.source
  }

  return result
}

/** 从 JSON 文本解析并消毒 */
export function sanitizeExcalidrawSceneJson(
  text: string
): SanitizedExcalidrawScene | null {
  try {
    const raw = safeJsonParse(text)
    return sanitizeExcalidrawScene(raw)
  } catch {
    return null
  }
}
