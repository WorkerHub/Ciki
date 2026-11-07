/**
 * Confluence 剪贴板清洗管线 —— 由粘贴验证小样 v0.4 的 prototype/src/cleaner.js
 * 逐段移植（规格 §5）。输入：剪贴板 text/html；输出：可被 TipTap Schema 吃下的干净 HTML。
 * 原则：保结构（标题/代码/表格合并/列表层级/任务），剥 Confluence 垃圾属性与高亮 span。
 *
 * 相对小样的唯一产品化改动：外链图片（Confluence 附件、任意外部 URL）不再保留 src，
 * 而是把原地址移进 data-original-src 并打 data-confluence-img，交给图片 NodeView 渲染
 * 「未转存」占位。这与服务端消毒规则（契约 §三 图片）一致，所以保存前后表现相同，
 * 也不会在编辑器里替用户去请求外链图片。
 *
 * 注意：前端清洗不是安全边界，服务端保存时还会二次消毒（规格 §5.8）。
 */

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

/** 本站图片 / 内联图片之外的一切 src 都算「未转存」。 */
function isHostedImageSrc(src: string): boolean {
  if (!src) return false
  if (/^data:image\//i.test(src)) return true
  return /^\/api\/files\//.test(src)
}

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

  // 5) 图片：外链（Confluence 附件或任意外部图）转成「未转存」标记
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || ""
    if (isHostedImageSrc(src)) return
    const original = img.getAttribute("data-original-src") || src
    if (original) img.setAttribute("data-original-src", original)
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

  // 7) 属性白名单清洗
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
    TD: ["colspan", "rowspan"],
    TH: ["colspan", "rowspan"],
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

  // 8) 解包无语义容器：div/section/article/span/font/center/figure/button
  // 反复执行直到没有可解包元素（处理嵌套）
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
      Array.from(el.childNodes).forEach((node) => {
        el.parentNode?.insertBefore(node, el)
      })
      el.remove()
      changed = true
    })
    if (!changed) break
  }

  // 9) 清理空段落（保留单个空行结构：连续空段只留一个）
  root.querySelectorAll("p").forEach((p) => {
    if (!p.textContent?.trim() && !p.querySelector("img,br,hr")) p.remove()
  })

  return root.innerHTML.trim()
}
