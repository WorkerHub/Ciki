import { describe, expect, it } from "vitest"
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  validateImageFile
} from "@/lib/upload"

describe("upload.ts: validateImageFile", () => {
  it("接受支持的图片格式且不再由客户端写死阻拦大于 10MB 的图片（交由服务端及生效值判定）", () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      const file11Mb = new File(["test"], "test.png", { type })
      Object.defineProperty(file11Mb, "size", { value: 11 * 1024 * 1024 })
      expect(validateImageFile(file11Mb)).toBeNull()
    }
  })

  it("拒绝不支持的格式如 svg 和文本", () => {
    const svgFile = new File(["<svg></svg>"], "test.svg", {
      type: "image/svg+xml"
    })
    expect(validateImageFile(svgFile)).toBe(
      "只支持 PNG / JPG / GIF / WebP 图片（SVG 不收）"
    )

    const textFile = new File(["hello"], "test.txt", { type: "text/plain" })
    expect(validateImageFile(textFile)).toBe(
      "只支持 PNG / JPG / GIF / WebP 图片（SVG 不收）"
    )
  })

  it("常量 MAX_IMAGE_BYTES 保留为 10MB 默认基准", () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
  })
})
