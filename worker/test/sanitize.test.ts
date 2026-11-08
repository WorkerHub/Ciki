import { describe, expect, it } from "vitest"
import {
  isAllowedImageSrc,
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
