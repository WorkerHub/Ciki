/**
 * 「下载 .md」的服务端分流（规格 v1.0，2026-11-10 用户拍板）：
 *
 * - 无站内图 → 与一期前端产物逐字节一致的 `.md`；
 * - 有站内图 → zip 包（根 `<标题>.md` + `images/<basename>`），图从 R2 直读、流式入包。
 *
 * 用 fflate 的 `unzipSync` 真解一遍包再断言——「能被标准实现解开」本身就是验收项，
 * 拿正则手抠 zip 字节给不出这个保证。
 */
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import {
  asciiFilenameFallback,
  cleanPageFilename,
  contentDisposition,
  imageEntryNames,
  markdownDocument,
  rewriteSiteImageLinks,
  siteImageKeys
} from "../src/lib/markdown-download"
import {
  adminSession,
  createApiToken,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import { MemoryR2 } from "./support/memory-r2"

const ORIGIN = "https://ciki.oneboy.app"
const SITE = `${ORIGIN}/api/files`

/** 站内图 key（UUID 形状过 UPLOAD_KEY_RE）：一张带 `pages/` 前缀，一张是存量平铺。 */
const KEY_PAGES = "pages/11111111-2222-4333-8444-555555555555.png"
const KEY_FLAT = "66666666-7777-4888-9999-aaaaaaaaaaaa.png"
const UUID_PAGES = "11111111-2222-4333-8444-555555555555.png"
const UUID_FLAT = "66666666-7777-4888-9999-aaaaaaaaaaaa.png"
const KEY_MISSING = "imports/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.png"

type Env = Parameters<typeof adminSession>[0]

interface PageDetail {
  id: string
  title: string
  contentMd: string
}

/** 一小段「像图」的字节：内容不重要，重要的是逐字节进出不变。 */
function imageBytes(seed: number, size = 128): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  for (let index = 8; index < size; index += 1) {
    bytes[index] = (seed * 31 + index) % 251
  }
  return bytes
}

function textBlock(text: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text }]
  }
}

function imageBlock(src: string, alt: string) {
  return { type: "image", attrs: { src, alt } }
}

function docWith(blocks: unknown[]): string {
  return JSON.stringify({ type: "doc", content: blocks })
}

async function createPage(
  env: Env,
  cookie: string,
  title: string,
  contentJson: string,
  spaceId?: string
): Promise<PageDetail> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      spaceId: spaceId ?? null,
      parentId: null,
      contentJson,
      contentHtml: "<p>正文</p>",
      contentText: "正文"
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageDetail
}

function download(env: Env, id: string, cookie?: string): Promise<Response> {
  return request(env, `/api/pages/${id}/download`, {
    headers: cookie ? { cookie } : {}
  })
}

/** 把 zip 响应体解开成 `{ 包内路径: 字节 }`。 */
async function unzip(
  res: Response
): Promise<{ entries: Record<string, Uint8Array>; names: string[] }> {
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
  return { entries, names: Object.keys(entries).sort() }
}

function expectZipHeaders(res: Response, filename: string, mainName: string) {
  expect(res.headers.get("content-type")).toBe("application/zip")
  const disposition = res.headers.get("content-disposition") ?? ""
  expect(disposition).toContain("attachment;")
  expect(disposition).toContain(`filename="${filename}"`)
  expect(disposition).toContain(
    `filename*=UTF-8''${encodeURIComponent(`${mainName}.zip`)}`
  )
}

function expectMarkdownHeaders(
  res: Response,
  filename: string,
  mainName: string
) {
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
  const disposition = res.headers.get("content-disposition") ?? ""
  expect(disposition).toContain("attachment;")
  expect(disposition).toContain(`filename="${filename}"`)
  expect(disposition).toContain(
    `filename*=UTF-8''${encodeURIComponent(`${mainName}.md`)}`
  )
}

interface ZipHeader {
  name: string
  /** 中央目录「version made by」的高字节：0 = MS-DOS，3 = Unix。 */
  hostOs: number
  /** 通用位标志：bit 11 = 条目名是 UTF-8。 */
  flags: number
  /** 外部文件属性：Unix 语义时高 16 位是权限位。 */
  externalAttrs: number
}

/**
 * 读中央目录的条目头（zip 规范的固定布局，字段位置见 APPNOTE 4.3.12）。
 *
 * `unzipSync` 只回内容，看不到宿主系统与外部属性，而 macOS 系统 unzip 能不能解出中文
 * 名恰恰取决于这两个字段（#72），所以测试侧自己按规范读字节。
 */
function zipHeaders(bytes: Uint8Array): ZipHeader[] {
  const view = new DataView(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength
  )
  let eocd = -1
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error("zip 末尾找不到中央目录结束记录（EOCD）")

  const count = view.getUint16(eocd + 10, true)
  let pointer = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const headers: ZipHeader[] = []
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) {
      throw new Error("中央目录条目签名不对")
    }
    const madeBy = view.getUint16(pointer + 4, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    headers.push({
      name: decoder.decode(
        bytes.subarray(pointer + 46, pointer + 46 + nameLength)
      ),
      hostOs: madeBy >> 8,
      flags: view.getUint16(pointer + 8, true),
      externalAttrs: view.getUint32(pointer + 38, true)
    })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return headers
}

describe("含图页：下载得 zip（验收 §1）", () => {
  const TITLE = "含图的页面"
  const DETAIL = docWith([
    textBlock("正文开头。"),
    imageBlock(`/api/files/${KEY_PAGES}`, "站内图甲"),
    imageBlock("https://example.com/ext.png", "站外图"),
    imageBlock(`/api/files/${KEY_FLAT}`, "站内图乙"),
    imageBlock(`/api/files/${KEY_PAGES}`, "站内图甲"),
    textBlock("正文结尾。")
  ])

  /** 一期前端的产物口径：`# 标题\n\n` + contentMd.trimEnd() + `\n`。 */
  const OLD_BODY = [
    "正文开头。",
    "",
    `![站内图甲](${SITE}/${KEY_PAGES})`,
    "",
    "![站外图](https://example.com/ext.png)",
    "",
    `![站内图乙](${SITE}/${KEY_FLAT})`,
    "",
    `![站内图甲](${SITE}/${KEY_PAGES})`,
    "",
    "正文结尾。"
  ].join("\n")

  async function scenario() {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, TITLE, DETAIL)
    expect(page.contentMd).toBe(OLD_BODY)
    const r2 = env.R2 as unknown as MemoryR2
    await r2.put(KEY_PAGES, imageBytes(1), {
      httpMetadata: { contentType: "image/png" }
    })
    await r2.put(KEY_FLAT, imageBytes(2), {
      httpMetadata: { contentType: "image/png" }
    })
    return { env, db, admin, page, r2 }
  }

  it("结构与链接：两图各一份（同图引用两次只一份）、站内相对、站外原样", async () => {
    const { env, admin, page } = await scenario()

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    // 中文主名由 filename* 承载；filename 给 ASCII 兜底（清不出 ASCII 就是 page）。
    expectZipHeaders(res, "page.zip", TITLE)

    const { entries, names } = await unzip(res)
    expect(names).toEqual(
      ["含图的页面.md", `images/${UUID_FLAT}`, `images/${UUID_PAGES}`].sort()
    )
    expect(entries[`images/${UUID_PAGES}`]).toEqual(imageBytes(1))
    expect(entries[`images/${UUID_FLAT}`]).toEqual(imageBytes(2))

    const markdownInZip = strFromU8(entries["含图的页面.md"])
    expect(markdownInZip).toBe(
      [
        `# ${TITLE}`,
        "",
        "正文开头。",
        "",
        `![站内图甲](images/${UUID_PAGES})`,
        "",
        "![站外图](https://example.com/ext.png)",
        "",
        `![站内图乙](images/${UUID_FLAT})`,
        "",
        `![站内图甲](images/${UUID_PAGES})`,
        "",
        "正文结尾。",
        ""
      ].join("\n")
    )

    // 只改链接：把站内图地址（绝对 / 相对）抹平后，其余正文与一期产物逐字相同。
    const mask = (value: string) =>
      value.replace(
        /\((?:https:\/\/ciki\.oneboy\.app\/api\/files\/|images\/)[^)\n]+\)/g,
        "(LINK)"
      )
    expect(mask(markdownInZip)).toBe(mask(`# ${TITLE}\n\n${OLD_BODY}\n`))
  })

  it("存储版不动：content_md 与详情接口仍是绝对地址版（规格 §4）", async () => {
    const { env, db, admin, page } = await scenario()

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    await res.arrayBuffer()

    const row = db.db
      .prepare("SELECT content_md FROM ciki_pages WHERE id = ?")
      .get(page.id) as { content_md: string }
    expect(row.content_md).toBe(OLD_BODY)

    const detail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as PageDetail
    expect(detail.contentMd).toBe(OLD_BODY)
    expect(detail.contentMd).toContain(`${SITE}/${KEY_PAGES}`)
  })
})

describe("无图页：下载仍是 .md（验收 §2）", () => {
  it("正文与一期产物逐字节一致", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "纯文字页",
      docWith([textBlock("第一段"), textBlock("第二段")])
    )

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    expectMarkdownHeaders(res, "page.md", "纯文字页")
    const body = await res.text()
    expect(body).toBe("# 纯文字页\n\n第一段\n\n第二段\n")
    expect(body).toBe(
      markdownDocument({ title: "纯文字页", contentMd: page.contentMd })
    )
  })

  it("空正文只有标题行；站外图与不合规 key 不触发 zip", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const empty = await createPage(env, admin, "  空页  ", docWith([]))
    const emptyRes = await download(env, empty.id, admin)
    expect(emptyRes.status).toBe(200)
    expect(await emptyRes.text()).toBe("# 空页\n")

    const external = await createPage(
      env,
      admin,
      "外链页",
      docWith([
        imageBlock("https://example.com/a.png", "外链"),
        // 本站地址但不是 UPLOAD_KEY_RE 的形状（svg / 非 uuid）：按站外处理。
        imageBlock(`${SITE}/pages/not-a-uuid.svg`, "形状不合规")
      ])
    )
    const externalRes = await download(env, external.id, admin)
    expect(externalRes.status).toBe(200)
    expect(externalRes.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    )
    const body = await externalRes.text()
    expect(body).toContain("![外链](https://example.com/a.png)")
    expect(body).toContain(`![形状不合规](${SITE}/pages/not-a-uuid.svg)`)
  })
})

describe("缺图兜底：R2 里已不存在（验收 §3）", () => {
  it("整包仍成功，缺图不入包且链接保留绝对地址", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "有缺图",
      docWith([
        imageBlock(`/api/files/${KEY_PAGES}`, "在的图"),
        imageBlock(`/api/files/${KEY_MISSING}`, "已删的图")
      ])
    )
    await (env.R2 as unknown as MemoryR2).put(KEY_PAGES, imageBytes(3))

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    const { entries, names } = await unzip(res)
    expect(names).toEqual(["有缺图.md", `images/${UUID_PAGES}`].sort())

    const markdown = strFromU8(entries["有缺图.md"])
    expect(markdown).toContain(`![在的图](images/${UUID_PAGES})`)
    expect(markdown).toContain(`![已删的图](${SITE}/${KEY_MISSING})`)
  })

  it("全部缺图：分流只看引用，包内只有 MD 且全是绝对地址", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "全缺图",
      docWith([imageBlock(`/api/files/${KEY_PAGES}`, "缺一")])
    )

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    const { entries, names } = await unzip(res)
    expect(names).toEqual(["全缺图.md"])
    expect(strFromU8(entries["全缺图.md"])).toBe(
      `# 全缺图\n\n![缺一](${SITE}/${KEY_PAGES})\n`
    )
  })
})

describe("zip 条目头：Unix 语义 + UTF-8 标志位（macOS 系统 unzip 兼容，#72）", () => {
  it("中文标题：每个条目都是 os=3 + 0644，中文名带 UTF-8 标志位", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "含图的页面",
      docWith([textBlock("正文"), imageBlock(`/api/files/${KEY_PAGES}`, "图")])
    )
    await (env.R2 as unknown as MemoryR2).put(KEY_PAGES, imageBytes(6))

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const headers = zipHeaders(bytes)
    expect(headers.map((header) => header.name).sort()).toEqual(
      [`images/${UUID_PAGES}`, "含图的页面.md"].sort()
    )

    for (const header of headers) {
      // fflate 默认 os = 0（MS-DOS）、attrs = 0：Info-ZIP 会按 DOS 代码页解码
      // 中文名，macOS 的系统 unzip 因此解不出 .md（退出码 50）。
      expect(header.hostOs, header.name).toBe(3)
      expect(header.externalAttrs >>> 16, header.name).toBe(0o644)
    }
    const markdown = headers.find((header) => header.name.endsWith(".md"))!
    const image = headers.find((header) => header.name.startsWith("images/"))!
    // UTF-8 标志位由 fflate 按名字内容置位：中文名有、ASCII 名没有。
    expect(markdown.flags & 0x800, "中文条目名应带 UTF-8 标志位").toBeTruthy()
    expect(image.flags & 0x800).toBeFalsy()

    // 标准实现照旧能解（头部字段改动不能弄坏内容）。
    const entries = unzipSync(bytes)
    expect(Object.keys(entries).sort()).toEqual(
      [`images/${UUID_PAGES}`, "含图的页面.md"].sort()
    )
    expect(strFromU8(entries["含图的页面.md"])).toBe(
      `# 含图的页面\n\n正文\n\n![图](images/${UUID_PAGES})\n`
    )
  })

  it("ASCII 标题：同样 Unix 语义，且不带 UTF-8 标志位（不回归）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "Deploy Runbook",
      docWith([textBlock("正文"), imageBlock(`/api/files/${KEY_FLAT}`, "图")])
    )
    await (env.R2 as unknown as MemoryR2).put(KEY_FLAT, imageBytes(7))

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const headers = zipHeaders(bytes)
    expect(headers.map((header) => header.name).sort()).toEqual(
      ["Deploy Runbook.md", `images/${UUID_FLAT}`].sort()
    )
    for (const header of headers) {
      expect(header.hostOs, header.name).toBe(3)
      expect(header.externalAttrs >>> 16, header.name).toBe(0o644)
      expect(header.flags & 0x800, header.name).toBeFalsy()
    }
    expect(strFromU8(unzipSync(bytes)["Deploy Runbook.md"])).toBe(
      `# Deploy Runbook\n\n正文\n\n![图](images/${UUID_FLAT})\n`
    )
  })
})

describe("文件名（沿用一期 markdownFilename 的口径）", () => {
  it("中文主名走 filename*；非法字符换成 `-`，标题行保留原样", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "支付/服务:部署*手册?",
      docWith([textBlock("正文")])
    )

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    expectMarkdownHeaders(res, "page.md", "支付-服务-部署-手册")
    expect(await res.text()).toBe("# 支付/服务:部署*手册?\n\n正文\n")
  })

  it("ASCII 标题：filename 与 filename* 一致", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(
      env,
      admin,
      "Release Notes 版本 2.0",
      docWith([imageBlock(`/api/files/${KEY_FLAT}`, "图")])
    )
    await (env.R2 as unknown as MemoryR2).put(KEY_FLAT, imageBytes(4))

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    expectZipHeaders(res, "Release Notes - 2.0.zip", "Release Notes 版本 2.0")
    await res.arrayBuffer()
  })

  it("清洗规则与 ASCII 兜底；响应头不带控制字符（无头部注入）", () => {
    expect(cleanPageFilename("  ///  ")).toBe("未命名页面")
    expect(cleanPageFilename("a\u0000b/c")).toBe("ab-c")
    expect(cleanPageFilename("版本 2.0. ")).toBe("版本 2.0")
    expect(asciiFilenameFallback("未命名页面")).toBe("page")
    expect(asciiFilenameFallback("版本 2.0")).toBe("2.0")
    expect(asciiFilenameFallback("Release Notes 版本 2.0")).toBe(
      "Release Notes - 2.0"
    )
    const disposition = contentDisposition(
      cleanPageFilename("a\r\nb\u0000"),
      ".md"
    )
    expect(disposition).not.toContain("\n")
    expect(disposition).not.toContain("\r")
  })
})

describe("包内图片命名：撞名兜底（规格 §3）", () => {
  it("basename 不撞就取 basename；撞了按 key 全路径下划线化", () => {
    const same = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png"
    const names = imageEntryNames([
      `pages/${same}`,
      `imports/${same}`,
      KEY_FLAT
    ])
    expect(names.get(`pages/${same}`)).toBe(`pages_${same}`)
    expect(names.get(`imports/${same}`)).toBe(`imports_${same}`)
    expect(names.get(KEY_FLAT)).toBe(UUID_FLAT)
  })
})

describe("链接改写只认站内图（单元口径）", () => {
  it("站内图入包才相对化，缺图与不合规地址原样保留", () => {
    const markdown = [
      `![甲](${SITE}/${KEY_PAGES})`,
      `![乙](${SITE}/${KEY_MISSING})`,
      `![丙](${SITE}/pages/not-a-uuid.svg)`,
      "![丁](https://example.com/d.png)",
      `[普通链接](${SITE}/${KEY_FLAT})`
    ].join("\n\n")

    // 普通链接里的本站地址不是「图片引用」，既不计入分流依据，也不改写。
    expect(siteImageKeys(markdown)).toEqual([KEY_PAGES, KEY_MISSING])

    const rewritten = rewriteSiteImageLinks(markdown, (key) =>
      key === KEY_MISSING ? null : "x.png"
    )
    expect(rewritten).toContain("![甲](images/x.png)")
    expect(rewritten).toContain(`![乙](${SITE}/${KEY_MISSING})`)
    expect(rewritten).toContain(`![丙](${SITE}/pages/not-a-uuid.svg)`)
    expect(rewritten).toContain("![丁](https://example.com/d.png)")
    // 普通链接（非图片引用）不在改写范围内。
    expect(rewritten).toContain(`[普通链接](${SITE}/${KEY_FLAT})`)
  })
})

describe("权限与隔离", () => {
  it("viewer 可下载；非成员 / 已删 / 未登录 / 只读令牌一律拒绝", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const viewer = await userSession(env, admin, "viewer@example.com")
    const outsider = await userSession(env, admin, "outsider@example.com")

    // 另建一个空间：新注册用户只在默认空间里，非成员要单独造。
    const space = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "下载测试空间" },
        admin
      )
    ).json()) as { id: string }
    const viewerId = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, viewer)
    ).json()) as { id: string }
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: viewerId.id, role: "viewer" },
      admin
    )

    const page = await createPage(
      env,
      admin,
      "成员页",
      docWith([textBlock("正文"), imageBlock(`/api/files/${KEY_PAGES}`, "图")]),
      space.id
    )
    await (env.R2 as unknown as MemoryR2).put(KEY_PAGES, imageBytes(5))

    const viewerRes = await download(env, page.id, viewer)
    expect(viewerRes.status).toBe(200)
    expect(viewerRes.headers.get("content-type")).toBe("application/zip")
    await viewerRes.arrayBuffer()

    expect((await download(env, page.id, outsider)).status).toBe(404)
    expect((await download(env, page.id)).status).toBe(401)

    // 只读令牌（Bearer）进不了这个会话端点。
    const issued = await createApiToken(env, admin, "read")
    const readonlyRes = await request(env, `/api/pages/${page.id}/download`, {
      headers: { authorization: `Bearer ${issued.token}` }
    })
    expect(readonlyRes.status).toBe(401)

    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    expect((await download(env, page.id, admin)).status).toBe(404)
  })
})

/**
 * 大页量级 + 流式行为（验收 §4、规格 §7）：24 张图、每张 200KB，上游逐块吐字节。
 *
 * 断言的是**内存方式**而不是速度：输出不等整包读完——响应第一块到手时上游才读掉
 * 一小截；整个过程中「已读未消费」的积压始终远小于包体，说明没有把整包/整图先攒进
 * 内存再吐。
 */
class StreamingR2 extends MemoryR2 {
  /** 上游（R2 替身）累计吐出的字节数。 */
  bytesPulled = 0

  override async get(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    const bytes = entry.bytes
    const chunkSize = 16 * 1024
    let offset = 0
    const r2 = this
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        const end = Math.min(offset + chunkSize, bytes.length)
        r2.bytesPulled += end - offset
        controller.enqueue(bytes.slice(offset, end))
        offset = end
      }
    })
    return { key, size: bytes.length, body } as unknown as R2ObjectBody
  }
}

describe("24 图量级：流式组装（验收 §4）", () => {
  it("边读边吐、不预读整包，包结构仍标准可解", async () => {
    const r2 = new StreamingR2()
    const { env } = await initializedContext({
      R2: r2 as unknown as R2Bucket
    })
    const admin = await adminSession(env)
    const imageKeys = Array.from({ length: 24 }, (_, index) => {
      const head = `0000000${index % 10}`
      const tail = String(index).padStart(12, "0")
      return `pages/${head}-aaaa-4bbb-8ccc-${tail}.png`
    })
    const size = 200 * 1024

    const page = await createPage(
      env,
      admin,
      "24 图页",
      docWith(
        imageKeys.map((key, index) =>
          imageBlock(`/api/files/${key}`, `图 ${index + 1}`)
        )
      )
    )
    for (const [index, key] of imageKeys.entries()) {
      await r2.put(key, imageBytes(index + 10, size))
    }
    const totalBytes = imageKeys.length * size

    const res = await download(env, page.id, admin)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zip")
    // 即便响应还没被读，上游也只被读走一小截：没有「先攒完整包」那一步。
    expect(r2.bytesPulled).toBeLessThan(totalBytes / 4)

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let consumed = 0
    let backlog = 0
    const first = await reader.read()
    expect(first.done).toBe(false)
    // 第一块输出到手时，上游远未读完。
    expect(r2.bytesPulled).toBeLessThan(totalBytes / 2)
    if (first.value) {
      chunks.push(first.value)
      consumed += first.value.byteLength
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      consumed += value.byteLength
      backlog = Math.max(backlog, r2.bytesPulled - consumed)
    }

    // 积压始终远小于包体本身（水位 1MiB + 一块），不是「全量读完再吐」。
    expect(backlog).toBeLessThan(2 * 1024 * 1024)
    expect(totalBytes).toBeGreaterThan(4 * 1024 * 1024)

    const joined = new Uint8Array(consumed)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    const entries = unzipSync(joined)
    expect(Object.keys(entries)).toHaveLength(25)
    for (const [index, key] of imageKeys.entries()) {
      const name = key.slice(key.lastIndexOf("/") + 1)
      expect(entries[`images/${name}`]).toEqual(imageBytes(index + 10, size))
    }
    const markdown = strFromU8(entries["24 图页.md"])
    expect(markdown.match(/images\/[^)]+/g)).toHaveLength(24)
  }, 30_000)
})
