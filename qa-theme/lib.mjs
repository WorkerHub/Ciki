// Ciki 主题全矩阵 QA —— 公共库
// 约束：真实生产请求；证据输出前过 clean() 清 Cookie/令牌。
import { mkdirSync } from "node:fs"

export const BASE = "https://ciki.oneboy.app"
export const QA_DIR = new URL(".", import.meta.url).pathname
export const SHOTS = QA_DIR + "shots/"
mkdirSync(SHOTS, { recursive: true })
mkdirSync(QA_DIR + "evidence/", { recursive: true })

// ── 证据清洗：任何落盘文本先过这里 ────────────────────────────────
export function clean(text) {
  if (typeof text !== "string") text = String(text ?? "")
  return text
    .replace(/ciki_session=[^;\s"']+/gi, "ciki_session=[REDACTED]")
    .replace(/[A-Za-z0-9_-]{40,}/g, (m) =>
      /^[A-Za-z0-9_-]*$/.test(m) && !/^[0-9a-f]{8}-/.test(m)
        ? "[REDACTED]"
        : m
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
}

// ── 会话化 API 客户端（undici 直连，不走代理；curl --noproxy '*' 同口径）──
export class Api {
  constructor(name = "") {
    this.name = name
    this.cookies = new Map() // name -> value
  }
  cookieHeader() {
    return [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
  }
  absorb(res) {
    const set = res.headers.getSetCookie?.() ?? []
    for (const line of set) {
      const [pair] = line.split(";")
      const idx = pair.indexOf("=")
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }
  async req(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) }
    if (this.cookies.size) headers.cookie = this.cookieHeader()
    let payload
    if (body instanceof FormData) {
      // fetch 会自动补 multipart boundary
    } else if (body !== undefined) {
      headers["content-type"] = "application/json"
      payload = JSON.stringify(body)
    }
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: payload ?? (body instanceof FormData ? body : undefined),
      redirect: "manual"
    })
    this.absorb(res)
    return res
  }
  async json(method, path, body, opts = {}) {
    const res = await this.req(method, path, body, opts)
    let data = null
    const text = await res.text()
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 400) }
    }
    return { status: res.status, data, res }
  }
  async upload(path, filename, blob, type) {
    const form = new FormData()
    form.append("file", new Blob([blob], { type }), filename)
    return this.json("POST", path, form)
  }
}

// ── WCAG 对比度 ─────────────────────────────────────────────────
function parseColor(str) {
  // rgb(a) 或 oklch —— oklch 先按浏览器渲染值 rgba() 处理；getComputedStyle 返回 rgb()
  const m = /rgba?\(([^)]+)\)/.exec(str)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  if (parts.length >= 3) return { r: parts[0], g: parts[1], b: parts[2] }
  return null
}
function srgbChannel(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
export function luminance(colorStr) {
  const c = parseColor(colorStr)
  if (!c) return null
  return (
    0.2126 * srgbChannel(c.r) +
    0.7152 * srgbChannel(c.g) +
    0.0722 * srgbChannel(c.b)
  )
}
export function contrast(fg, bg) {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  if (l1 === null || l2 === null) return null
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

// ── 汇报 ────────────────────────────────────────────────────────
export function report(name, pass, detail) {
  const tag = pass ? "PASS" : "FAIL"
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`)
  return pass
}
