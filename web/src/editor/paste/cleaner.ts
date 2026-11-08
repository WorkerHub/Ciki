/**
 * Confluence 剪贴板清洗管线 —— 由粘贴验证小样 v0.4 的 prototype/src/cleaner.js
 * 逐段移植（规格 §5）。输入：剪贴板 text/html；输出：可被 TipTap Schema 吃下的干净 HTML。
 * 原则：保结构（标题/代码/表格合并/列表层级/任务），剥 Confluence 垃圾属性与高亮 span；
 * 文本颜色/高亮/单元格底色是例外：颜色值归一成 `#rrggbb` 后落到 data 载具上保留。
 *
 * 相对小样的唯一产品化改动：外链图片（Confluence 附件、任意外部 URL）不再保留 src，
 * 而是把原地址移进 data-original-src 并打 data-confluence-img，交给图片 NodeView 渲染
 * 「未转存」占位。这与服务端消毒规则（契约 §三 图片）一致，所以保存前后表现相同，
 * 也不会在编辑器里替用户去请求外链图片。
 *
 * 注意：前端清洗不是安全边界，服务端保存时还会二次消毒（规格 §5.8）。
 */
import { isHostedImageSrc, safeExternalUrl } from "@/lib/media"
import { normalizeColor } from "@/lib/color"

function parseFragment(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="__root">${html}</div></body></html>`,
    "text/html"
  )
  const root = doc.getElementById("__root")
  if (!root) throw new Error("清洗管线：无法解析剪贴板 HTML")
  return root
}

function extractPreText(pre: Element): string {
  // 代码块取纯文本：<br> 换行、.line 分行、其余取 textContent
  const clone = pre.cloneNode(true) as Element
  clone.querySelectorAll("br").forEach((br) => {
    br.replaceWith("\n")
  })
  const lines = clone.querySelectorAll(".line, .code-line")
  if (lines.length > 1) {
    return Array.from(lines)
      .map((line) => line.textContent ?? "")
      .join("\n")
  }
  return (clone.textContent ?? "").replace(/\u00a0/g, " ")
}

function detectLang(pre: Element): string {
  const candidates = [
    pre.getAttribute("data-syntaxhighlighter-params") || "",
    pre.getAttribute("class") || "",
    pre.getAttribute("data-language") || ""
  ]
  const code = pre.querySelector("code")
  if (code) candidates.push(code.getAttribute("class") || "")
  const joined = candidates.join(" ")
  let match = joined.match(/brush:\s*([\w+#-]+)/i)
  if (match) return match[1].toLowerCase()
  match = joined.match(/language-([\w+#-]+)/i)
  if (match) return match[1].toLowerCase()
  return ""
}

const PANEL_LABELS: { match: string; label: string }[] = [
  { match: "information", label: "ℹ️ 提示" },
  { match: "note", label: "📝 注意" },
  { match: "warning", label: "⚠️ 警告" },
  { match: "success", label: "✅ 提示" },
  { match: "tip", label: "✅ 提示" },
  { match: "error", label: "⛔ 错误" }
]

// 图片地址白名单与后端契约逐个字符对齐（见 lib/media.ts）

export function cleanConfluenceHtml(html: string): string {
  if (!html?.trim()) return ""
  // 纯文本粘贴
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    const div = document.createElement("div")
    div.textContent = html.trim()
    return `<p>${div.innerHTML.replace(/\n/g, "<br>")}</p>`
  }
  const root = parseFragment(html)
  const doc = root.ownerDocument

  // 1) 删除危险/无用元素
  root
    .querySelectorAll(
      "script,style,meta,link,title,noscript,iframe,object,embed,form,head"
    )
    .forEach((el) => {
      el.remove()
    })

  // 2) 信息面板宏 -> blockquote（降级，必须在 div 解包之前）
  root.querySelectorAll("div").forEach((div) => {
    const cls = div.getAttribute("class") || ""
    if (!cls.includes("confluence-information-macro")) return
    const panel =
      PANEL_LABELS.find((entry) => cls.includes(entry.match)) ?? PANEL_LABELS[0]
    const blockquote = doc.createElement("blockquote")
    const head = doc.createElement("p")
    const strong = doc.createElement("strong")
    strong.textContent = panel.label
    head.appendChild(strong)
    blockquote.appendChild(head)
    // 面板正文通常在 .confluence-information-macro-body 里
    const body = div.querySelector(".confluence-information-macro-body") ?? div
    Array.from(body.childNodes).forEach((node) => {
      blockquote.appendChild(node.cloneNode(true))
    })
    div.replaceWith(blockquote)
  })

  // 2.5) SyntaxHighlighter 表格型代码块（从 Confluence 阅读页复制时是这种形态）：
  // <div class="syntaxhighlighter sql"><table><tr><td class="gutter">行号</td>
  // <td class="code"><div class="line"><code class="sql keyword">with</code> …</div></td></tr></table></div>
  // 必须整块转成一个 <pre>：丢行号列、逐行取纯文本、逐词 <code> 合并。
  // 否则行号会被挤成一串、代码会变成满屏行内代码药丸。
  const SH_IGNORE = new Set([
    "syntaxhighlighter",
    "nogutter",
    "gutter",
    "printing",
    "collapsed",
    "expanded",
    "wrappable",
    "scrollbar"
  ])

  function convertShBlock(blockEl: Element, tableEl: Element | null) {
    const scope = tableEl ?? blockEl
    const codeCell = scope.querySelector("td.code") ?? scope
    let lang = ""
    ;(blockEl.getAttribute("class") || "").split(/\s+/).forEach((token) => {
      if (token && !SH_IGNORE.has(token) && !lang) lang = token.toLowerCase()
    })
    if (!lang) {
      const firstCode = codeCell.querySelector("code")
      if (firstCode) {
        lang = (
          (firstCode.getAttribute("class") || "").split(/\s+/)[0] || ""
        ).toLowerCase()
      }
    }
    const lines = codeCell.querySelectorAll(".line")
    const text = lines.length
      ? Array.from(lines)
          .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
          .join("\n")
      : (codeCell.textContent ?? "").replace(/\u00a0/g, " ")
    const nextPre = doc.createElement("pre")
    const code = doc.createElement("code")
    if (lang && /^[a-z0-9+#-]+$/.test(lang))
      code.setAttribute("class", `language-${lang}`)
    code.textContent = text.replace(/\n+$/, "")
    nextPre.appendChild(code)
    ;(tableEl ?? blockEl).replaceWith(nextPre)
  }

  root.querySelectorAll(".syntaxhighlighter").forEach((el) => {
    if (el.tagName === "PRE") return // syntaxhighlighter-pre 是编辑器形态，走第 3 步
    convertShBlock(el, el.querySelector("table"))
  })
  // 兜底：包装 div 丢失、只剩带 gutter 列的表格
  root.querySelectorAll("td.gutter").forEach((td) => {
    const table = td.closest("table")
    if (table) convertShBlock(table, table)
  })

  // 3) 代码块：剥高亮 span，提取语言，重建 <pre><code>
  root.querySelectorAll("pre").forEach((pre) => {
    const lang = detectLang(pre)
    const text = extractPreText(pre).replace(/\n+$/, "")
    const nextPre = doc.createElement("pre")
    const code = doc.createElement("code")
    if (lang) code.setAttribute("class", `language-${lang}`)
    code.textContent = text
    nextPre.appendChild(code)
    pre.replaceWith(nextPre)
  })

  // 4) 任务列表 -> TipTap TaskList 结构
  root.querySelectorAll("ul").forEach((ul) => {
    const cls = ul.getAttribute("class") || ""
    const isTask =
      cls.includes("task") ||
      Boolean(ul.querySelector("li[data-task-status], li.task-list-item"))
    if (!isTask) return
    ul.setAttribute("data-type", "taskList")
    ul.querySelectorAll("li").forEach((li) => {
      const status = (li.getAttribute("data-task-status") || "").toLowerCase()
      const classes = (li.getAttribute("class") || "")
        .toLowerCase()
        .split(/\s+/)
      const checked =
        status === "complete" ||
        classes.includes("checked") ||
        classes.includes("complete") ||
        Boolean(li.querySelector('input[type="checkbox"][checked]'))
      li.setAttribute("data-type", "taskItem")
      li.setAttribute("data-checked", checked ? "true" : "false")
      li.querySelectorAll(
        'input[type="checkbox"], .task-status, span.placeholder-inline-tasks'
      ).forEach((el) => {
        el.remove()
      })
    })
  })

  // 5) 图片：本站图床/合规内联图以外的都转成「未转存」标记；
  //    data-original-src 只留 http(s) 与根相对路径，javascript:/data:text/html 一律丢弃，
  //    避免读态把它渲染成可点击链接。
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || ""
    if (isHostedImageSrc(src)) return
    const original = safeExternalUrl(
      img.getAttribute("data-original-src") || src
    )
    if (original) img.setAttribute("data-original-src", original)
    else img.removeAttribute("data-original-src")
    img.setAttribute("data-confluence-img", "true")
    img.removeAttribute("src")
  })

  // 6) 表格：保留 colgroup 列宽（v0.4，表格不应默认撑满行宽）：
  // 把 col 的 style width 归一为 width 属性，只接受 px / % 数值。
  root.querySelectorAll("col").forEach((col) => {
    const style = col.getAttribute("style") || ""
    const match = style.match(/width\s*:\s*([\d.]+(?:px|%))/i)
    const width = col.getAttribute("width") || (match ? match[1] : "")
    if (/^[\d.]+(px|%)$/.test(width)) col.setAttribute("width", width)
    else col.removeAttribute("width")
    col.removeAttribute("style")
  })

  // 7) 颜色：只认内联 `color` 与 `background-color`，归一成 `#rrggbb` 后落到契约载具上
  // （span[data-text-color] / mark[data-color] / td,th[data-cell-bg]），其余内联样式
  // 照旧剥干净（整条 style 直接移除）。颜色不走 style 的原因见 colors/extensions.ts：
  // Worker 的 zeed-dom 渲染会丢 style，只有普通属性才能三路（编辑/粘贴/导入）一致。
  const INLINE_TAGS = new Set([
    "SPAN",
    "FONT",
    "B",
    "STRONG",
    "EM",
    "I",
    "U",
    "S",
    "DEL",
    "STRIKE",
    "A",
    "CODE",
    "SUB",
    "SUP",
    "MARK"
  ])
  const BLOCK_DESCENDANTS = "p,div,ul,ol,table,pre,blockquote,li,figure"

  function wrapChildren(target: Element, wrapper: Element) {
    Array.from(target.childNodes).forEach((node) => {
      wrapper.appendChild(node)
    })
    target.appendChild(wrapper)
  }

  root.querySelectorAll("[style], font[color]").forEach((el) => {
    const style = el.getAttribute("style") || ""
    let color: string | null = null
    let background: string | null = null
    style.split(";").forEach((declaration) => {
      const colon = declaration.indexOf(":")
      if (colon < 0) return
      const property = declaration.slice(0, colon).trim().toLowerCase()
      // Confluence 会带 !important，去掉再归一
      const value = declaration
        .slice(colon + 1)
        .replace(/!important\s*$/i, "")
        .trim()
      if (property === "color") color = normalizeColor(value)
      else if (property === "background-color")
        background = normalizeColor(value)
    })
    // 老式 <font color="#de350b">
    if (!color && el.tagName === "FONT") {
      color = normalizeColor(el.getAttribute("color"))
    }
    el.removeAttribute("style")

    if (background) {
      if (el.tagName === "TD" || el.tagName === "TH") {
        el.setAttribute("data-cell-bg", background)
      } else if (el.tagName === "MARK") {
        el.setAttribute("data-color", background)
      } else if (INLINE_TAGS.has(el.tagName) && el.childNodes.length) {
        // 块级内容（如 li 里嵌了列表）不包 mark：会造出非法嵌套
        const mark = doc.createElement("mark")
        mark.setAttribute("data-color", background)
        wrapChildren(el, mark)
      }
    }

    if (color) {
      if (el.tagName === "SPAN") {
        el.setAttribute("data-text-color", color)
      } else if (!el.querySelector(BLOCK_DESCENDANTS) && el.childNodes.length) {
        const span = doc.createElement("span")
        span.setAttribute("data-text-color", color)
        wrapChildren(el, span)
      }
    }
  })

  // 8) 属性白名单清洗
  const ALLOWED: Record<string, string[]> = {
    A: ["href", "title"],
    IMG: [
      "src",
      "alt",
      "title",
      "width",
      "height",
      "data-confluence-img",
      "data-original-src"
    ],
    TD: ["colspan", "rowspan", "data-cell-bg"],
    TH: ["colspan", "rowspan", "data-cell-bg"],
    SPAN: ["data-text-color"],
    MARK: ["data-color"],
    COL: ["width"],
    CODE: ["class"],
    UL: ["data-type"],
    LI: ["data-type", "data-checked"]
  }
  root.querySelectorAll("*").forEach((el) => {
    const keep = ALLOWED[el.tagName] ?? []
    Array.from(el.attributes).forEach((attr) => {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name)
      if (
        el.tagName === "CODE" &&
        attr.name === "class" &&
        !/^language-[\w+#-]+$/.test(attr.value)
      ) {
        el.removeAttribute("class")
      }
    })
  })

  // 9) 解包无语义容器：div/section/article/span/font/center/figure/button
  // 反复执行直到没有可解包元素（处理嵌套）。带颜色的 span 是载具，不能解包。
  for (let round = 0; round < 8; round += 1) {
    let changed = false
    root
      .querySelectorAll("div,section,article,figure,center,font,button")
      .forEach((el) => {
        if (!el.parentNode) return
        Array.from(el.childNodes).forEach((node) => {
          el.parentNode?.insertBefore(node, el)
        })
        el.remove()
        changed = true
      })
    root.querySelectorAll("span").forEach((el) => {
      if (!el.parentNode) return
      if (el.hasAttribute("data-text-color")) return
      Array.from(el.childNodes).forEach((node) => {
        el.parentNode?.insertBefore(node, el)
      })
      el.remove()
      changed = true
    })
    if (!changed) break
  }

  // 10) 清理空段落（保留单个空行结构：连续空段只留一个）
  root.querySelectorAll("p").forEach((p) => {
    if (!p.textContent?.trim() && !p.querySelector("img,br,hr")) p.remove()
  })

  return root.innerHTML.trim()
}
