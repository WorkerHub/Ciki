/**
 * 版本正文取不到 / 渲染不了时的口径（同一个入口 `revisionContent`，靠 `readContent`
 * 是否抛错区分）。
 *
 * 契约：正文取不到——内容对象整个不见了（指针脏了/被误删）、内容桶整体不可用、gzip
 * 字节已损坏——都属于基础设施或数据可用性问题，回 500 `CONTENT_MISSING`（与阅读接口
 * `GET /api/pages/:id?format=json` 取不到正文同口径）；只有「JSON 取到了、但按当前
 * 编辑器 schema 渲染不了」才是内容本身的问题，回 422 `REVISION_UNRENDERABLE`。
 * 两类失败都不能写回页面。
 */
import { describe, expect, it, vi } from "vitest"
import { contentObjectKey } from "../src/core/content-store"
import { gzipText } from "../src/lib/gzip"
import { initializedContext } from "./support/app"
import {
  adminWithPage,
  getRevision,
  pageSnapshot,
  restoreRevision,
  revisionRows
} from "./support/revisions"

/** 能解析、但按当前编辑器 schema 渲染不了的一段 JSON（codeBlock 折叠态的脏属性）。 */
const UNRENDERABLE_JSON = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { collapsed: "true" },
      content: [{ type: "text", text: "line 1" }]
    }
  ]
})

const CONTENT_MISSING_BODY = {
  error: "Page content unavailable",
  code: "CONTENT_MISSING"
}

describe("版本正文取不到", () => {
  it("内容对象缺失：查看与回滚都回 500 CONTENT_MISSING，页面一字未动", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "缺对象页")
    const [revision] = revisionRows(context.db, page.id)

    // 只删内容桶里的对象，库里指针原样留着（真实场景：误删/迁移未完成）。
    await env.CONTENT.delete(contentObjectKey(revision.content_hash))
    const snapshot = pageSnapshot(context.db, page.id)

    const view = await getRevision(env, admin, page.id, revision.version_no)
    expect(view.status).toBe(500)
    expect(await view.json()).toEqual(CONTENT_MISSING_BODY)

    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      revision.version_no
    )
    expect(restore.status).toBe(500)
    expect(await restore.json()).toEqual(CONTENT_MISSING_BODY)

    // 回滚失败不落库：页面行、指针与 FTS 全等。
    expect(pageSnapshot(context.db, page.id)).toEqual(snapshot)
  })

  it("内容桶整体不可用：查看与回滚都回 500 CONTENT_MISSING，页面一字未动", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "桶不可用页")
    const [revision] = revisionRows(context.db, page.id)
    const snapshot = pageSnapshot(context.db, page.id)

    // R2 整桶不可用（绑定/网络故障）：对象还在内存里也读不到。
    const get = vi
      .spyOn(context.content, "get")
      .mockImplementation(async () => {
        throw new Error("R2 is unavailable")
      })
    try {
      // 基础设施故障不能被说成「内容渲染失败」（422 + 编辑器版本提示）。
      const view = await getRevision(env, admin, page.id, revision.version_no)
      expect(view.status).toBe(500)
      expect(await view.json()).toEqual(CONTENT_MISSING_BODY)

      const restore = await restoreRevision(
        env,
        admin,
        page.id,
        revision.version_no
      )
      expect(restore.status).toBe(500)
      expect(await restore.json()).toEqual(CONTENT_MISSING_BODY)

      expect(pageSnapshot(context.db, page.id)).toEqual(snapshot)
    } finally {
      get.mockRestore()
    }
  })
})

describe("版本 JSON 取到了但渲染不了", () => {
  it("查看与回滚都回 422 REVISION_UNRENDERABLE，页面一字未动", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "渲染不了页")
    const [revision] = revisionRows(context.db, page.id)
    const snapshot = pageSnapshot(context.db, page.id)

    // 测试里只能这样造出「指针指向渲染不了的正文」：把该哈希对应的对象换成一段
    // 能解析、但 schema 不认的 JSON（真实场景是历史编辑器版本写下的脏属性）。
    await env.CONTENT.put(
      contentObjectKey(revision.content_hash),
      await gzipText(UNRENDERABLE_JSON)
    )

    const view = await getRevision(env, admin, page.id, revision.version_no)
    expect(view.status).toBe(422)
    const viewBody = (await view.json()) as { error: string; code: string }
    expect(viewBody.code).toBe("REVISION_UNRENDERABLE")
    expect(viewBody.error).toContain("Revision content cannot be rendered")

    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      revision.version_no
    )
    expect(restore.status).toBe(422)
    expect(((await restore.json()) as { code: string }).code).toBe(
      "REVISION_UNRENDERABLE"
    )
    expect(pageSnapshot(context.db, page.id)).toEqual(snapshot)
  })
})

describe("含画布块（excalidraw）的版本渲染", () => {
  it("查看与回滚含 excalidraw 节点的版本均成功渲染（不报 422 REVISION_UNRENDERABLE）", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "画布版本页")
    const [revision] = revisionRows(context.db, page.id)

    const sceneKey = "pages/1b3e5a7d-890f-4e3b-b21c-4f8a9e0d1c2b.json"
    const previewKey = "pages/7fa3c5b1-e221-4d1a-8c90-9f201b1a3e45.png"
    const excalidrawDoc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "画布正文" }]
        },
        {
          type: "excalidraw",
          attrs: {
            sceneKey,
            previewKey,
            extractedText: "架构设计图",
            width: 720
          }
        }
      ]
    })

    await env.CONTENT.put(
      contentObjectKey(revision.content_hash),
      await gzipText(excalidrawDoc)
    )

    const view = await getRevision(env, admin, page.id, revision.version_no)
    expect(view.status).toBe(200)
    const viewBody = (await view.json()) as {
      contentHtml: string
      contentJson: string
      contentText: string
    }
    expect(viewBody.contentHtml).toContain('data-type="excalidraw"')
    expect(viewBody.contentHtml).toContain(`data-scene-key="${sceneKey}"`)
    expect(viewBody.contentHtml).toContain(`data-preview-key="${previewKey}"`)
    expect(viewBody.contentHtml).toContain(`src="/api/files/${previewKey}"`)
    expect(viewBody.contentHtml).toContain('alt="架构设计图"')
    expect(viewBody.contentHtml).toContain('width="720"')

    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      revision.version_no
    )
    expect(restore.status).toBe(200)
    const restoreBody = (await restore.json()) as {
      contentHtml: string
      contentMd: string
    }
    expect(restoreBody.contentHtml).toContain('data-type="excalidraw"')
    expect(restoreBody.contentMd).toContain(
      `![架构设计图](https://ciki.oneboy.app/api/files/${previewKey})`
    )
  })
})
