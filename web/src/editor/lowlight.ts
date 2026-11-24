import { createLowlight } from "lowlight"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

/** 主路径只注册最高频的核心语言（含交互式 shell），其余按需加载，大幅缩减初始 chunk 体积 */
const initialLanguages = {
  bash,
  css,
  javascript,
  json,
  markdown,
  python,
  shell,
  sql,
  typescript,
  xml,
  yaml
}

export const lowlight = createLowlight(initialLanguages)

/** 常见语言别名映射 */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  golang: "go",
  rs: "rust",
  cs: "csharp",
  "c++": "cpp",
  h: "c",
  html: "xml",
  md: "markdown",
  yml: "yaml",
  rb: "ruby",
  kt: "kotlin"
}

/** 非核心语言按需动态加载表 */
const DYNAMIC_LOADERS: Record<string, () => Promise<{ default: any }>> = {
  arduino: () => import("highlight.js/lib/languages/arduino"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  diff: () => import("highlight.js/lib/languages/diff"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  "php-template": () => import("highlight.js/lib/languages/php-template"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
  "python-repl": () => import("highlight.js/lib/languages/python-repl"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  swift: () => import("highlight.js/lib/languages/swift"),
  vbnet: () => import("highlight.js/lib/languages/vbnet"),
  wasm: () => import("highlight.js/lib/languages/wasm")
}

const loadingPromises = new Map<string, Promise<boolean>>()

/** 按需加载语言包并注入 lowlight */
export async function loadLanguage(
  lang: string | null | undefined
): Promise<boolean> {
  if (!lang) return false
  const normalized = lang.toLowerCase().trim()
  if (lowlight.registered(normalized)) return true

  const targetLang = LANGUAGE_ALIASES[normalized] ?? normalized
  if (lowlight.registered(targetLang)) {
    if (targetLang !== normalized && !lowlight.registered(normalized)) {
      lowlight.registerAlias(targetLang, normalized)
    }
    return true
  }

  const loader = DYNAMIC_LOADERS[targetLang]
  if (!loader) return false

  const cached = loadingPromises.get(targetLang)
  if (cached) return cached

  const promise = (async () => {
    try {
      const mod = await loader()
      const syntax = mod.default || mod
      lowlight.register(targetLang, syntax)
      if (targetLang !== normalized && !lowlight.registered(normalized)) {
        lowlight.registerAlias(targetLang, normalized)
      }
      return true
    } catch {
      return false
    } finally {
      loadingPromises.delete(targetLang)
    }
  })()

  loadingPromises.set(targetLang, promise)
  return promise
}

/**
 * 安全兜底：
 * 1. highlight: 遇到未注册语言或解析异常时安全返回空结构，不抛错；
 * 2. highlightAuto: 捕获异常，确保推断失败时不抛错，安全返回空结构。
 */
const rawHighlight = lowlight.highlight.bind(lowlight)
lowlight.highlight = (lang: string, code: string) => {
  try {
    if (lowlight.registered(lang)) {
      return rawHighlight(lang, code)
    }
  } catch {
    // 捕获任意内部解析异常
  }
  return { type: "root", children: [] }
}

const rawHighlightAuto = lowlight.highlightAuto.bind(lowlight)
lowlight.highlightAuto = (code: string) => {
  try {
    return rawHighlightAuto(code)
  } catch {
    return { type: "root", children: [] }
  }
}
