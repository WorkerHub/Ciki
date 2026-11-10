import { afterEach, describe, expect, it, vi } from "vitest"
import {
  downloadMarkdown,
  markdownDocument,
  markdownFilename
} from "@/lib/markdown-download"

afterEach(() => {
  vi.restoreAllMocks()
  // jsdom 没有 createObjectURL：本文件自己补上，用完删掉，别影响别的用例
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

describe("下载 .md 的文件名", () => {
  it("标题原样加 .md 后缀", () => {
    expect(markdownFilename("支付服务部署手册")).toBe("支付服务部署手册.md")
  })

  it("路径分隔符等非法字符换成 -，结尾的点与空格去掉", () => {
    expect(markdownFilename("a/b:c*d?")).toBe("a-b-c-d.md")
    expect(markdownFilename("版本 2.0. ")).toBe("版本 2.0.md")
  })

  it("标题清不出可用名字时退回「未命名页面」", () => {
    expect(markdownFilename("/")).toBe("未命名页面.md")
    expect(markdownFilename("   ")).toBe("未命名页面.md")
  })
})

describe("下载 .md 的内容", () => {
  it("标题一级标题 + 空行 + content_md，末尾一个换行", () => {
    expect(
      markdownDocument({
        title: "支付服务部署手册",
        contentMd: "## 部署\n\n正文"
      })
    ).toBe("# 支付服务部署手册\n\n## 部署\n\n正文\n")
  })

  it("content_md 自带的尾部空行先去掉，只差标题行", () => {
    expect(markdownDocument({ title: "部署", contentMd: "正文\n\n\n" })).toBe(
      "# 部署\n\n正文\n"
    )
  })

  it("空正文只留标题行", () => {
    expect(markdownDocument({ title: "部署", contentMd: "" })).toBe("# 部署\n")
    expect(markdownDocument({ title: "  部署  ", contentMd: "" })).toBe(
      "# 部署\n"
    )
  })
})

describe("downloadMarkdown 触发下载", () => {
  it("把文档作为 markdown Blob 交给下载链接，文件名用页面标题", async () => {
    const blobs: Blob[] = []
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return "blob:ciki-md"
      })
    })
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL
    })
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this)
    })

    downloadMarkdown({ title: "支付服务部署手册", contentMd: "正文" })

    expect(clicked).toHaveLength(1)
    expect(clicked[0].download).toBe("支付服务部署手册.md")
    expect(clicked[0].getAttribute("href")).toBe("blob:ciki-md")
    // 链接用完从文档里摘掉，不在页面上留残骸
    expect(document.querySelector("a[download]")).toBeNull()
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe("text/markdown;charset=utf-8")
    expect(await blobs[0].text()).toBe("# 支付服务部署手册\n\n正文\n")

    // revoke 让出一轮事件循环，避免个别浏览器还没读到内容
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:ciki-md")
  })
})
