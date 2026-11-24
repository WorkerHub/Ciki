import fs from "node:fs"
import { launch, newContext, attachSession, installTheme, goto, writeJson, SHOTS } from "./lib.mjs"

/** 深挖度量：纹理、字体回退、对比度、代码/表格/画布/Embed 细节 */
const BASE = process.env.QA_BASE || "http://127.0.0.1:9311"
const COOKIE = process.env.QA_COOKIE || "/tmp/qa/cookies-new.json"

const COMBOS = [
  { style: "nova", mode: "light" },
  { style: "nova", mode: "dark" },
  { style: "paper", mode: "light" },
  { style: "paper", mode: "dark" }
]

const browser = await launch()
const report = {}

for (const combo of COMBOS) {
  const key = `${combo.style}-${combo.mode}`
  const context = await newContext(browser, { width: 1440, height: 900 })
  await attachSession(context, COOKIE)
  await installTheme(context, combo.style, combo.mode)
  const page = await context.newPage()
  await goto(page, BASE, "/p/1", "h1")
  await page.waitForTimeout(800)

  const data = await page.evaluate(() => {
    const root = document.documentElement
    const cs = getComputedStyle(root)
    const after = getComputedStyle(document.body, "::after")
    const before = getComputedStyle(document.body, "::before")

    // --- 字体回退 ---
    const probe = document.createElement("span")
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:64px;white-space:nowrap"
    document.body.appendChild(probe)
    const measure = (font, text) => {
      probe.style.fontFamily = font
      probe.textContent = text
      return probe.getBoundingClientRect().width
    }
    const bodyFont = getComputedStyle(document.body).fontFamily
    const cjk = "中文回退链验证"
    const widths = {
      bodyStack: measure(bodyFont, cjk),
      pingfang: measure('"PingFang SC"', cjk),
      notoCjk: measure('"Noto Sans CJK SC"', cjk),
      interOnly: measure('"Inter Variable"', cjk),
      systemSans: measure("sans-serif", cjk)
    }
    // 代码块等宽性：i 与 W 宽度应一致
    const codeEl = document.querySelector(".wiki-content .code-block code") || document.querySelector("pre code")
    let mono = null
    if (codeEl) {
      const ccs = getComputedStyle(codeEl)
      const m = (t) => {
        probe.style.fontFamily = ccs.fontFamily
        probe.style.fontSize = ccs.fontSize
        probe.textContent = t
        return probe.getBoundingClientRect().width
      }
      mono = {
        fontFamily: ccs.fontFamily,
        widthI: m("iiiiiiiiii"),
        widthW: m("WWWWWWWWWW"),
        widthM: m("MMMMMMMMMM"),
        whiteSpace: ccs.whiteSpace,
        fontSize: ccs.fontSize,
        lineHeight: ccs.lineHeight
      }
      mono.monospace = Math.abs(mono.widthI - mono.widthW) < 0.5
    }
    // 字体可用性（浏览器报告是否覆盖该字符）
    const fontsAvail = {
      interLatin: document.fonts.check('16px "Inter Variable"', "A"),
      interCJK: document.fonts.check('16px "Inter Variable"', "中"),
      pingfangCJK: document.fonts.check('16px "PingFang SC"', "中"),
      jbMonoLatin: document.fonts.check('16px "JetBrains Mono Variable"', "A")
    }
    probe.remove()

    // --- 文本与颜色 ---
    const para = document.querySelector(".wiki-content p")
    const codeBlock = document.querySelector(".wiki-content .code-block")
    const pre = document.querySelector(".wiki-content .code-block pre")
    const table = document.querySelector(".wiki-content table")
    const th = document.querySelector(".wiki-content table th")
    const td = document.querySelector(".wiki-content table td")
    const canvasImg = document.querySelector('[data-canvas-block] img, .wiki-content img[src*="preview"], .wiki-content canvas, .excalidraw img')
    const iframe = document.querySelector(".wiki-content iframe")
    const blockquote = document.querySelector(".wiki-content blockquote")

    const rgb = (s) => {
      const m = String(s).match(/-?[\d.]+/g)
      if (!m) return null
      return { r: +m[0], g: +m[1], b: +m[2] }
    }
    const lum = (c) => {
      if (!c) return null
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const contrast = (a, b) => {
      const l1 = lum(a)
      const l2 = lum(b)
      if (l1 === null || l2 === null) return null
      const hi = Math.max(l1, l2)
      const lo = Math.min(l1, l2)
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }

    const bgOf = (el) => {
      if (!el) return null
      let n = el
      while (n) {
        const c = getComputedStyle(n).backgroundColor
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c
        n = n.parentElement
      }
      return getComputedStyle(document.body).backgroundColor
    }

    return {
      theme: {
        dataTheme: root.getAttribute("data-theme"),
        dataMode: root.getAttribute("data-mode"),
        darkClass: root.classList.contains("dark"),
        colorScheme: root.style.colorScheme,
        stored: localStorage.getItem("ciki-theme")
      },
      texture: {
        afterContent: after.content,
        afterBgImage: after.backgroundImage.slice(0, 60),
        afterOpacity: after.opacity,
        afterBlend: after.mixBlendMode,
        afterPointerEvents: after.pointerEvents,
        afterZIndex: after.zIndex,
        beforeBgImage: before.backgroundImage.slice(0, 40)
      },
      fonts: {
        bodyFont,
        widths,
        fontsAvail,
        mono
      },
      colors: {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyFg: getComputedStyle(document.body).color,
        paraFg: para ? getComputedStyle(para).color : null,
        paraBg: para ? bgOf(para) : null,
        paraFont: para ? getComputedStyle(para).fontFamily : null,
        paraFontSize: para ? getComputedStyle(para).fontSize : null,
        paraLineHeight: para ? getComputedStyle(para).lineHeight : null,
        codeBg: codeBlock ? getComputedStyle(codeBlock).backgroundColor : null,
        codeFg: pre ? getComputedStyle(pre).color : null,
        codeFont: pre ? getComputedStyle(pre).fontFamily : null,
        tableThBg: th ? getComputedStyle(th).backgroundColor : null,
        tableThFg: th ? getComputedStyle(th).color : null,
        tableTdFg: td ? getComputedStyle(td).color : null,
        tableBorder: table ? getComputedStyle(table).borderColor : null,
        quoteBg: blockquote ? getComputedStyle(blockquote).backgroundColor : null,
        quoteFg: blockquote ? getComputedStyle(blockquote).color : null
      },
      contrast: {
        para: para ? contrast(rgb(getComputedStyle(para).color), rgb(bgOf(para))) : null,
        code: pre ? contrast(rgb(getComputedStyle(pre).color), rgb(bgOf(pre))) : null,
        tableTh: th ? contrast(rgb(getComputedStyle(th).color), rgb(getComputedStyle(th).backgroundColor)) : null,
        tableCell: td ? contrast(rgb(getComputedStyle(td).color), rgb(bgOf(td))) : null,
        quote: blockquote
          ? contrast(rgb(getComputedStyle(blockquote).color), rgb(bgOf(blockquote)))
          : null
      },
      blocks: {
        codeBlocks: document.querySelectorAll(".wiki-content .code-block").length,
        tables: document.querySelectorAll(".wiki-content table").length,
        canvasBlocks: document.querySelectorAll('[data-canvas-block], .canvas-block, .excalidraw').length,
        embeds: document.querySelectorAll(".wiki-content iframe").length,
        canvasImgSrc: canvasImg ? canvasImg.getAttribute("src") : null,
        canvasImgNatural: canvasImg
          ? { w: canvasImg.naturalWidth, h: canvasImg.naturalHeight }
          : null,
        iframeSrc: iframe ? iframe.getAttribute("src") : null,
        iframeBox: iframe
          ? {
              w: iframe.getBoundingClientRect().width,
              h: iframe.getBoundingClientRect().height,
              border: getComputedStyle(iframe).border,
              radius: getComputedStyle(iframe).borderRadius,
              bg: getComputedStyle(iframe).backgroundColor
            }
          : null
      }
    }
  })

  // Embed iframe 内部文档是否被主题污染
  const frames = page.frames()
  let frameInfo = []
  for (const f of frames) {
    if (f === page.mainFrame()) continue
    try {
      const t = await f.evaluate(() => ({
        url: location.href,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyFg: getComputedStyle(document.body).color,
        text: document.body.innerText.slice(0, 60),
        dataTheme: document.documentElement.getAttribute("data-theme")
      }))
      frameInfo.push(t)
    } catch {
      frameInfo.push({ url: f.url(), error: "无法读取（跨域）" })
    }
  }
  data.frames = frameInfo

  // 背景纹理的实际像素扰动：取正文右侧空白列的一小块，统计亮度方差
  const grain = await page.evaluate(async () => {
    const c = document.createElement("canvas")
    return null
  })
  report[key] = data
  console.log(key, "grain:", JSON.stringify(data.texture.afterOpacity), data.texture.afterBlend, "frames:", frameInfo.length)
}

writeJson("/tmp/qa/deep-metrics.json", report)
await browser.close()
console.log("done")
