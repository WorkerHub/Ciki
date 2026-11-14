import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, type FileDownload } from "@/lib/api"
import {
  dispositionFilename,
  downloadPageMarkdown,
  markdownFilename
} from "@/lib/markdown-download"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    pagesApi: { ...actual.pagesApi, download: vi.fn() }
  }
})

const { pagesApi } = await import("@/lib/api")
const downloadMock = vi.mocked(pagesApi.download)

/** jsdom 没有 createObjectURL：给下载链路补上桩，并记录被点掉的链接。 */
function stubDownloadChain() {
  const blobs: Blob[] = []
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return "blob:ciki-download"
    })
  })
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL
  })
  const clicked: HTMLAnchorElement[] = []
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })
  return { blobs, revokeObjectURL, clicked, clickSpy }
}

function pageMarkdown(content: string): FileDownload {
  return {
    blob: new Blob([content], { type: "text/markdown;charset=utf-8" }),
    contentDisposition: null
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  downloadMock.mockReset()
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

describe("下载文件名的本地兜底", () => {
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

describe("解析 Content-Disposition 里的文件名", () => {
  it("优先用 filename*：中文按 UTF-8 百分号编码还原", () => {
    const header = `attachment; filename="ciki-page.zip"; filename*=UTF-8''${encodeURIComponent("支付服务部署手册.zip")}`
    expect(dispositionFilename(header)).toBe("支付服务部署手册.zip")
  })

  it("filename* 带语言标记也能解", () => {
    const header = `attachment; filename*=UTF-8'zh-CN'${encodeURIComponent("部署.md")}`
    expect(dispositionFilename(header)).toBe("部署.md")
  })

  it("没有 filename* 时用 filename（去引号，不做百分号解码）", () => {
    expect(dispositionFilename('attachment; filename="ciki-page.md"')).toBe(
      "ciki-page.md"
    )
    expect(dispositionFilename("attachment; filename=ciki-page.md")).toBe(
      "ciki-page.md"
    )
  })

  it("两种都没有 / 空头 / 空名字时返回 null，交给本地兜底", () => {
    expect(dispositionFilename(null)).toBeNull()
    expect(dispositionFilename("attachment")).toBeNull()
    expect(dispositionFilename('attachment; filename=""')).toBeNull()
    expect(dispositionFilename("attachment; filename*=UTF-8''")).toBeNull()
  })

  it("filename* 为空串时退回 filename", () => {
    const header = `ATTACHMENT; FILENAME="fallback.md"; FILENAME*=UTF-8''`
    expect(dispositionFilename(header)).toBe("fallback.md")
  })

  it("头字段名大小写不敏感（filename* 与 filename 均认）", () => {
    const extendedOnly = `ATTACHMENT; FiLeNaMe*=UTF-8''${encodeURIComponent("部署.md")}`
    expect(dispositionFilename(extendedOnly)).toBe("部署.md")
    expect(dispositionFilename('ATTACHMENT; FiLeNaMe="fallback.md"')).toBe(
      "fallback.md"
    )
  })

  it("filename* 不是 UTF-8 时不拿它充数，退回 filename，不把 *= 段当成名字", () => {
    const header =
      "attachment; filename*=ISO-8859-1''caf%e9.md; filename=\"fallback.md\""
    expect(dispositionFilename(header)).toBe("fallback.md")
  })

  it("filename* 不是 UTF-8 且没有 filename 时返回 null，交给本地兜底", () => {
    expect(
      dispositionFilename("attachment; filename*=ISO-8859-1''caf%e9.md")
    ).toBeNull()
  })

  it("百分号编码残缺时退回原串，不让整次下载因为文件名失败", () => {
    expect(dispositionFilename("attachment; filename*=UTF-8''%E6%94")).toBe(
      "%E6%94"
    )
  })
})

describe("downloadPageMarkdown 走服务端产物", () => {
  it("只发一次请求，前端不再自己拼 Markdown", async () => {
    const stub = stubDownloadChain()
    const blob = new Blob(["# 支付服务部署手册\n\n正文\n"], {
      type: "text/markdown;charset=utf-8"
    })
    downloadMock.mockResolvedValue({
      blob,
      contentDisposition: `attachment; filename="ciki-page.md"; filename*=UTF-8''${encodeURIComponent("支付服务部署手册.md")}`
    })

    await downloadPageMarkdown({ id: 1, title: "支付服务部署手册" })

    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(downloadMock).toHaveBeenCalledWith(1)
    expect(stub.clicked).toHaveLength(1)
    expect(stub.clicked[0].download).toBe("支付服务部署手册.md")
    expect(stub.clicked[0].getAttribute("href")).toBe("blob:ciki-download")
    // 链接用完从文档里摘掉，不在页面上留残骸
    expect(document.querySelector("a[download]")).toBeNull()
    // 服务端给的 blob 原样交给下载链接（zip 也走同一条路）
    expect(stub.blobs).toEqual([blob])

    // revoke 让出一轮事件循环，避免个别浏览器还没读到内容
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stub.revokeObjectURL).toHaveBeenCalledWith("blob:ciki-download")
    stub.clickSpy.mockRestore()
  })

  it("含图页的 zip 也原样下载，文件名用服务端给的 .zip", async () => {
    const stub = stubDownloadChain()
    const blob = new Blob(["PK\u0003\u0004zip"], { type: "application/zip" })
    downloadMock.mockResolvedValue({
      blob,
      contentDisposition: `attachment; filename="ciki-page.zip"; filename*=UTF-8''${encodeURIComponent("支付服务部署手册.zip")}`
    })

    await downloadPageMarkdown({ id: 2, title: "支付服务部署手册" })

    expect(stub.clicked[0].download).toBe("支付服务部署手册.zip")
    expect(stub.blobs[0].type).toBe("application/zip")
    stub.clickSpy.mockRestore()
  })

  it("服务端没给文件名时按页面标题兜底（本地口径仍给出 .md）", async () => {
    const stub = stubDownloadChain()
    downloadMock.mockResolvedValue(pageMarkdown("正文"))

    await downloadPageMarkdown({ id: 3, title: "支付服务部署手册" })

    expect(stub.clicked[0].download).toBe("支付服务部署手册.md")
    stub.clickSpy.mockRestore()
  })

  it("非 2xx 原样抛出，不生成任何文件", async () => {
    const stub = stubDownloadChain()
    const failure = new ApiError(
      404,
      "Not found",
      undefined,
      undefined,
      undefined,
      "/pages/p4/download"
    )
    downloadMock.mockRejectedValue(failure)

    await expect(
      downloadPageMarkdown({ id: 4, title: "支付服务部署手册" })
    ).rejects.toBe(failure)
    expect(stub.clicked).toHaveLength(0)
    expect(stub.blobs).toHaveLength(0)
    stub.clickSpy.mockRestore()
  })
})
