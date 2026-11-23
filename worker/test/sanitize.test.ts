import { describe, expect, it } from "vitest"
import {
  ALLOWED_FONT_SIZES,
  isAllowedImageSrc,
  sanitizeCommentHtml,
  sanitizePageHtml,
  toPlainText
} from "../src/lib/sanitize"

const UUID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
const FILE_URL = `/api/files/${UUID}.png`

describe("服务端二次消毒白名单", () => {
  it("剥除脚本、内联事件与样式标签", () => {
    const html = sanitizePageHtml(
      '<p onclick="x()">正文</p><script>alert(1)</script><style>p{}</style>' +
        '<iframe src="https://evil"></iframe><a href="javascript:alert(1)">链</a>'
    )
    expect(html).not.toContain("script")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("<style")
    expect(html).not.toContain("iframe")
    expect(html).not.toContain("javascript:")
    expect(html).toContain("正文")
  })

  it("保留表格合并单元格、列宽与受限 style", () => {
    const html = sanitizePageHtml(
      '<table style="min-width: 200px"><colgroup><col width="30%"><col style="width: 120px"></colgroup>' +
        '<tbody><tr><td colspan="2" rowspan="3">合并</td></tr></tbody></table>'
    )
    expect(html).toContain('colspan="2"')
    expect(html).toContain('rowspan="3"')
    expect(html).toContain('width="30%"')
    expect(html).toContain("width:120px")
    expect(html).toContain("min-width")
  })

  it("保留代码语言 class 与任务列表属性/只读勾选框", () => {
    const html = sanitizePageHtml(
      '<pre><code class="language-sql">select 1</code></pre>' +
        '<pre><code class="evil">x</code></pre>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">' +
        '<label><input type="checkbox" checked="checked"></label><div><p>完成</p></div></li></ul>'
    )
    expect(html).toContain('class="language-sql"')
    expect(html).not.toContain("evil")
    expect(html).toContain('data-type="taskList"')
    expect(html).toContain('data-checked="true"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("checked")
  })

  it("代码块折叠标记：只放行 true/false，非法值只删属性不动代码正文", () => {
    const kept = sanitizePageHtml(
      '<pre data-collapsed="true"><code class="language-js">a</code></pre>' +
        '<pre data-collapsed="false"><code>a</code></pre>'
    )
    expect(kept).toContain('<pre data-collapsed="true">')
    expect(kept).toContain('<pre data-collapsed="false">')

    // 非法值、裸属性、大小写变体一律只删属性：代码正文与语言标记照常保留。
    for (const value of ["yes", "", "TRUE", "1"]) {
      const html = sanitizePageHtml(
        `<pre data-collapsed="${value}" class="x"><code class="language-js">a</code></pre>`
      )
      expect(html).not.toContain("data-collapsed")
      expect(html).not.toContain('class="x"')
      expect(html).toContain('<pre><code class="language-js">a</code></pre>')
    }
  })

  it("本站图片与 data: 预览原样保留", () => {
    const html = sanitizePageHtml(
      `<img src="${FILE_URL}" alt="x"><img src="data:image/png;base64,iVBORw0KGgo=">`
    )
    expect(html).toContain(`src="${FILE_URL}"`)
    expect(html).toContain("data:image/png;base64")
    expect(isAllowedImageSrc(FILE_URL)).toBe(true)
  })

  it("新前缀的正文图（pages / imports）原样保留，avatars 与未知前缀转未转存", () => {
    for (const category of ["pages", "imports"]) {
      const url = `/api/files/${category}/${UUID}.png`
      expect(isAllowedImageSrc(url)).toBe(true)
      expect(sanitizePageHtml(`<img src="${url}" alt="x">`)).toContain(
        `src="${url}"`
      )
    }

    for (const url of [
      `/api/files/avatars/${UUID}.png`,
      `/api/files/misc/${UUID}.png`
    ]) {
      expect(isAllowedImageSrc(url)).toBe(false)
      const html = sanitizePageHtml(`<img src="${url}" alt="x">`)
      expect(html).not.toMatch(/<img[^>]*\ssrc=/)
      expect(html).toContain(`data-original-src="${url}"`)
    }
  })

  it("外链图片移入 data-original-src 并打未转存标记，不保留可直连 src", () => {
    const html = sanitizePageHtml(
      '<img src="https://confluence.example/download/a.png" alt="附件">'
    )
    expect(html).not.toContain(' src="https://confluence.example')
    expect(html).toContain(
      'data-original-src="https://confluence.example/download/a.png"'
    )
    expect(html).toContain('data-confluence-img="true"')
    expect(html).toContain('alt="附件"')
  })

  it("只保留 tableWrapper 容器 class，其它 class 被剥除", () => {
    const html = sanitizePageHtml(
      '<div class="tableWrapper"><table><tbody><tr><td>x</td></tr></tbody></table></div>' +
        '<p class="evil">y</p>'
    )
    expect(html).toContain('class="tableWrapper"')
    expect(html).not.toContain("evil")
  })
})

describe("颜色载具（文字颜色 / 高亮 / 单元格底色）", () => {
  it("三种载具原样保留，内联样式一律剥除", () => {
    const html = sanitizePageHtml(
      '<p><span data-text-color="#de350b" style="color: rgb(222, 53, 11);">红</span>' +
        '<mark data-color="#ffe58f" style="background-color: rgb(255, 229, 143); color: inherit;">亮</mark></p>' +
        '<table><tbody><tr><th colspan="1" rowspan="1" data-cell-bg="#f4f5f7" ' +
        'style="background-color: rgb(244, 245, 247);">H</th></tr></tbody></table>'
    )
    expect(html).toContain('data-text-color="#de350b"')
    expect(html).toContain('data-color="#ffe58f"')
    expect(html).toContain('data-cell-bg="#f4f5f7"')
    expect(html).not.toContain("style=")
    expect(html).not.toContain("<style")
  })

  it("非法色值（命名色 / rgb() / 带引号注入）不产出属性，内容不丢", () => {
    const html = sanitizePageHtml(
      '<p><span data-text-color="red">一</span>' +
        '<span data-text-color="rgb(222, 53, 11)">二</span>' +
        "<span data-text-color='#fff\" onmouseover=\"alert(1)'>三</span>" +
        '<mark data-color="javascript:alert(1)">四</mark></p>' +
        '<table><tbody><tr><td data-cell-bg="#12345">五</td></tr></tbody></table>'
    )
    expect(html).not.toContain("data-text-color=")
    expect(html).not.toContain("data-color=")
    expect(html).not.toContain("data-cell-bg=")
    expect(html).not.toContain("onmouseover")
    expect(html).not.toContain("javascript:")
    for (const text of ["一", "二", "三", "四", "五"]) {
      expect(html).toContain(text)
    }
  })

  it("大写 hex 收下并统一成小写（库里只有一种形态）", () => {
    const html = sanitizePageHtml(
      '<p><span data-text-color="#DE350B">红</span></p>'
    )
    expect(html).toContain('data-text-color="#de350b"')
    expect(html).not.toContain("style=")
  })
})

describe("行内字号载具（span[data-font-size]）", () => {
  it("7 档预设字号原样保留，内联样式一律剥除", () => {
    for (const size of ALLOWED_FONT_SIZES) {
      const html = sanitizePageHtml(
        `<p><span data-font-size="${size}" style="font-size: ${size};">字号</span></p>`
      )
      expect(html).toContain(`data-font-size="${size}"`)
      expect(html).not.toContain("style=")
    }
  })

  it("非法字号（超出档位 / 缺少单位 / 非法单位 / 任意 CSS / 带引号注入）不产出属性，文字不丢", () => {
    const html = sanitizePageHtml(
      '<p><span data-font-size="15px">一</span>' +
        '<span data-font-size="16">二</span>' +
        '<span data-font-size="1.2em">三</span>' +
        '<span data-font-size="24pt">四</span>' +
        '<span data-font-size="calc(10px + 2px)">五</span>' +
        "<span data-font-size='16px\" onmouseover=\"alert(1)'>六</span></p>"
    )
    expect(html).not.toContain("data-font-size=")
    expect(html).not.toContain("onmouseover")
    for (const text of ["一", "二", "三", "四", "五", "六"]) {
      expect(html).toContain(text)
    }
  })

  it("大写字号统一转为小写（如 16PX -> 16px）", () => {
    const html = sanitizePageHtml(
      '<p><span data-font-size="16PX">字号</span></p>'
    )
    expect(html).toContain('data-font-size="16px"')
    expect(html).not.toContain("16PX")
    expect(html).not.toContain("style=")
  })

  it("去除首尾空白（如 ' 18px ' -> '18px'）", () => {
    const html = sanitizePageHtml(
      '<p><span data-font-size=" 18px ">字号</span></p>'
    )
    expect(html).toContain('data-font-size="18px"')
  })

  it("字号与文字颜色可共存于同一个 span 载具上", () => {
    const html = sanitizePageHtml(
      '<p><span data-font-size="20px" data-text-color="#de350b" style="color: red; font-size: 20px;">大红字</span></p>'
    )
    expect(html).toContain('data-font-size="20px"')
    expect(html).toContain('data-text-color="#de350b"')
    expect(html).not.toContain("style=")
  })
})

describe("纯文本规范化的输入健壮性", () => {
  it("未闭合标签的病态输入线性返回（无 O(n²) 回溯）", () => {
    const input = "<a".repeat(300_000)
    const started = performance.now()
    const output = toPlainText(input)
    const elapsed = performance.now() - started

    expect(output.includes("<")).toBe(false)
    expect(output.includes(">")).toBe(false)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe("归一化的幂等性（无改动保存去重的前提）", () => {
  // 回滚与导入会把已落库的 HTML/纯文本再走一遍服务端归一化：只有这两步幂等，
  // 「回滚到与当前全等的版本」才不会被误判成有改动、多插一条 revision。
  it("落库形态的 HTML 与纯文本再归一化一次与原文全等", () => {
    const storedHtml = sanitizePageHtml(
      '<p onclick="x()">正文</p>' +
        '<img src="https://confluence.example/download/a.png" alt="附件" width="200">' +
        '<img src="/api/files/pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png" alt="画布" width="720" data-type="excalidraw" data-scene-key="pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json" data-preview-key="pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png">' +
        '<table style="min-width: 200px"><colgroup><col width="30%"><col style="width: 120px"></colgroup>' +
        '<tbody><tr><td colspan="2" data-cell-bg="#AABBCC">合并</td></tr></tbody></table>' +
        '<pre><code class="language-sql">select 1</code></pre>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">' +
        '<label><input type="checkbox" checked="checked"></label><div><p>完成</p></div></li></ul>' +
        '<p><span data-text-color="#FF0000">红</span><mark data-color="#00FF00">亮</mark><span data-font-size="24PX">大</span></p>'
    )
    expect(sanitizePageHtml(storedHtml)).toBe(storedHtml)

    const storedText = toPlainText(storedHtml)
    expect(storedText.length).toBeGreaterThan(0)
    expect(toPlainText(storedText)).toBe(storedText)
  })
})

describe("Excalidraw 画布块 HTML 载具属性消毒", () => {
  const sceneKey = "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json"
  const previewKey = "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png"
  const previewUrl = `/api/files/${previewKey}`

  it("合法画布块属性原样放行", () => {
    const html = sanitizePageHtml(
      `<img src="${previewUrl}" alt="提取的画布文字" width="720" ` +
        `data-type="excalidraw" data-scene-key="${sceneKey}" data-preview-key="${previewKey}">`
    )
    expect(html).toContain(`src="${previewUrl}"`)
    expect(html).toContain('alt="提取的画布文字"')
    expect(html).toContain('width="720"')
    expect(html).toContain('data-type="excalidraw"')
    expect(html).toContain(`data-scene-key="${sceneKey}"`)
    expect(html).toContain(`data-preview-key="${previewKey}"`)
  })

  it("data-type 仅放行 excalidraw，其余取值被剥除", () => {
    for (const invalid of ["image", "custom", "javascript:alert(1)", ""]) {
      const html = sanitizePageHtml(
        `<img src="${previewUrl}" data-type="${invalid}" data-scene-key="${sceneKey}" data-preview-key="${previewKey}">`
      )
      expect(html).not.toContain("data-type=")
      expect(html).toContain(`data-scene-key="${sceneKey}"`)
    }
  })

  it("data-scene-key 必须匹配 pages/<uuid>.json，非法值被剥除", () => {
    const invalidKeys = [
      "misc/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json",
      "pages/../etc/passwd",
      "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.png",
      "pages/not-a-uuid.json",
      "1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json",
      "javascript:alert(1)"
    ]
    for (const key of invalidKeys) {
      const html = sanitizePageHtml(
        `<img src="${previewUrl}" data-type="excalidraw" data-scene-key="${key}" data-preview-key="${previewKey}">`
      )
      expect(html).not.toContain("data-scene-key=")
      expect(html).toContain('data-type="excalidraw"')
    }
  })

  it("data-preview-key 必须匹配 pages/<uuid>.png，非法值被剥除", () => {
    const invalidKeys = [
      "misc/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png",
      "pages/../etc/passwd",
      "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.json",
      "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.jpg",
      "7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png"
    ]
    for (const key of invalidKeys) {
      const html = sanitizePageHtml(
        `<img src="${previewUrl}" data-type="excalidraw" data-scene-key="${sceneKey}" data-preview-key="${key}">`
      )
      expect(html).not.toContain("data-preview-key=")
      expect(html).toContain('data-type="excalidraw"')
    }
  })

  describe("Embed 内容块（htmlEmbed）HTML 载具属性消毒", () => {
    const embedKey = "embeds/550e8400-e29b-41d4-a716-446655440000.html"

    it("合法 htmlEmbed 属性原样放行", () => {
      const html = sanitizePageHtml(
        `<div data-type="html-embed" data-key="${embedKey}" data-height="600" data-name="animation.html"></div>`
      )
      expect(html).toContain('data-type="html-embed"')
      expect(html).toContain(`data-key="${embedKey}"`)
      expect(html).toContain('data-height="600"')
      expect(html).toContain('data-name="animation.html"')
    })

    it("data-type 仅放行 html-embed，其余被剥除", () => {
      for (const invalid of ["embed", "custom", "javascript:alert(1)", ""]) {
        const html = sanitizePageHtml(
          `<div data-type="${invalid}" data-key="${embedKey}" data-height="480" data-name="test.html"></div>`
        )
        expect(html).not.toContain("data-type=")
      }
    })

    it("data-key 必须匹配 embeds/<uuid>.html，非法值被剥除", () => {
      const invalidKeys = [
        "pages/550e8400-e29b-41d4-a716-446655440000.html",
        "embeds/../etc/passwd",
        "embeds/550e8400-e29b-41d4-a716-446655440000.png",
        "embeds/not-uuid.html",
        "550e8400-e29b-41d4-a716-446655440000.html"
      ]
      for (const key of invalidKeys) {
        const html = sanitizePageHtml(
          `<div data-type="html-embed" data-key="${key}" data-height="480" data-name="test.html"></div>`
        )
        expect(html).not.toContain("data-key=")
      }
    })

    it("data-height 仅收 200–2000 整数，其余值被剥除", () => {
      for (const invalid of [
        "100",
        "199",
        "2001",
        "3000",
        "480px",
        "abc",
        "-500"
      ]) {
        const html = sanitizePageHtml(
          `<div data-type="html-embed" data-key="${embedKey}" data-height="${invalid}" data-name="test.html"></div>`
        )
        expect(html).not.toContain("data-height=")
      }
      for (const valid of ["200", "480", "1200", "2000"]) {
        const html = sanitizePageHtml(
          `<div data-type="html-embed" data-key="${embedKey}" data-height="${valid}" data-name="test.html"></div>`
        )
        expect(html).toContain(`data-height="${valid}"`)
      }
    })

    it("评论消毒剥除全部 embed 属性（仅页面正文，不进评论）", () => {
      const html = sanitizeCommentHtml(
        `<div data-type="html-embed" data-key="${embedKey}" data-height="480" data-name="test.html">评论内容</div>`
      )
      expect(html).not.toContain("data-type=")
      expect(html).not.toContain("data-key=")
      expect(html).not.toContain("data-height=")
      expect(html).not.toContain("data-name=")
      expect(html).toContain("评论内容")
    })
  })
})
