import { describe, expect, it } from "vitest"
import {
  isHostedImageSrc,
  isSafeExternalUrl,
  safeExternalUrl
} from "@/lib/media"

const UUID = "0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b"

describe("图片地址白名单（与后端契约同义）", () => {
  it("认平铺与 pages/imports 前缀的地址，头像与未知前缀不收", () => {
    expect(isHostedImageSrc(`/api/files/${UUID}.png`)).toBe(true)
    expect(isHostedImageSrc(`/api/files/${UUID}.webp`)).toBe(true)
    expect(isHostedImageSrc(`/api/files/pages/${UUID}.png`)).toBe(true)
    expect(isHostedImageSrc(`/api/files/imports/${UUID}.jpeg`)).toBe(true)
    // 头像只服务资料页，不进正文
    expect(isHostedImageSrc(`/api/files/avatars/${UUID}.png`)).toBe(false)
    expect(isHostedImageSrc(`/api/files/misc/${UUID}.png`)).toBe(false)
    expect(isHostedImageSrc("/api/files/evil.png")).toBe(false)
    expect(isHostedImageSrc(`/api/files/${UUID}.svg`)).toBe(false)
    expect(isHostedImageSrc(`/api/files/${UUID}.png?x=1`)).toBe(false)
  })

  it("内联图只认 png/jpeg/gif/webp 的 base64，不收 svg", () => {
    expect(isHostedImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(true)
    expect(isHostedImageSrc("data:image/jpeg;base64,/9j/4AAQ")).toBe(true)
    expect(isHostedImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false)
    expect(isHostedImageSrc("data:text/html;base64,PHNjcmlwdD4=")).toBe(false)
  })

  it("外部地址只放行 http(s) 与根相对路径", () => {
    expect(isSafeExternalUrl("https://confluence.example.com/a.png")).toBe(true)
    expect(isSafeExternalUrl("http://example.com/a.png")).toBe(true)
    expect(isSafeExternalUrl("/download/a.png")).toBe(true)
    expect(isSafeExternalUrl("//evil.example.com/a.png")).toBe(false)
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false)
    expect(isSafeExternalUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false)
    expect(isSafeExternalUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false)
  })

  it("不安全的地址归一成空串，调用方展示纯文本", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBe("")
    expect(safeExternalUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png"
    )
  })
})
