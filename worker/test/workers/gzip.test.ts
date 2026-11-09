/**
 * gzip 存储路径在 **workerd** 里的回归护栏（Node 侧的完整用例见 test/revisions-gzip.test.ts）。
 *
 * 为什么单独放一条：这是仓库第一次用 `CompressionStream` / `DecompressionStream`，而
 * 「Node 下能跑」不等于「Workers 下能跑」（#32 的教训）。这里在真实 workerd 里把
 * 「文本 → gzip → 读回文本」跑通，并把版本正文的读路径（解压 → 渲染 → 消毒）也过一遍，
 * 保证部署后历史版本的查看/回滚不会在运行时上炸。
 */
import { describe, expect, it } from "vitest"
import { gzipText, gunzipText } from "../../src/lib/gzip"
import { normalizeImportedContent } from "../../src/lib/page-input"

const SAMPLE = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "版本正文" }] },
    {
      type: "image",
      attrs: {
        src: "/api/files/pages/33333333-3333-3333-3333-333333333333.png",
        alt: "图",
        title: null,
        originalSrc: null,
        confluenceImg: false
      }
    }
  ]
})

describe("workerd：gzip 编解码与版本读路径", () => {
  it("gzip → 解压后与原文逐字节相同，且确实是压缩的", async () => {
    const long = SAMPLE.repeat(20)
    const gzip = await gzipText(long)

    // gzip 魔数 1f 8b：落库的是真 gzip 字节，不是明文字符串。
    expect(gzip[0]).toBe(0x1f)
    expect(gzip[1]).toBe(0x8b)
    expect(new TextDecoder().decode(gzip)).not.toBe(long)
    expect(await gunzipText(gzip)).toBe(long)
    // D1 可能返回 ArrayBuffer：解压要同时吃下这种形态。
    const buffer = gzip.buffer.slice(
      gzip.byteOffset,
      gzip.byteOffset + gzip.byteLength
    )
    expect(await gunzipText(buffer)).toBe(long)
  })

  it("版本正文：解压出的 JSON 走上导入渲染链，图片与正文都在", async () => {
    const gzip = await gzipText(SAMPLE)
    const contentJson = await gunzipText(gzip)
    const result = normalizeImportedContent({ title: "版本页", contentJson })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.contentHtml).toContain(
      'src="/api/files/pages/33333333-3333-3333-3333-333333333333.png"'
    )
    expect(result.value.contentText).toBe("版本正文")
  })

  it("不是 gzip 的字节：报 GzipError，绝不把压缩字节当文本读", async () => {
    const plain = new TextEncoder().encode('{"type":"doc"}')
    await expect(gunzipText(plain)).rejects.toThrowError(/not gzip data/)
    await expect(gunzipText(null)).rejects.toThrowError(/not a byte buffer/)
  })
})
