import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"
import {
  normalizeImportedContent,
  normalizePageInput
} from "../src/lib/page-input"
import {
  hashContent,
  putContentHashed,
  readContent
} from "../src/core/content-store"
import { getPageRow } from "../src/db/queries/pages"
import { getTablePrefix } from "../src/lib/table-prefix"

interface SpaceDto {
  id: string
  name: string
  myRole: "admin" | "editor" | "viewer"
  isDefault: boolean
}

interface PageDetail {
  id: string
  spaceId: string
  parentId: string | null
  title: string
  contentHtml: string
  contentText: string
  contentMd: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

const VALID_SCENE_KEY = "pages/a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d.json"
const VALID_PREVIEW_KEY = "pages/f1e2d3c4-b5a6-4f1e-8d2c-3b4a5f6e7d8c.png"

function canvasDoc(
  sceneKey: string,
  previewKey?: string | null,
  extractedText = "系统架构图"
) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "画布前文本" }]
      },
      {
        type: "excalidraw",
        attrs: {
          sceneKey,
          ...(previewKey ? { previewKey } : {}),
          extractedText,
          width: 800
        }
      }
    ]
  }
}

describe("画布节点 sceneKey & previewKey 校验", () => {
  it("normalizePageInput：合法的 sceneKey（且可选省略 previewKey）放行", () => {
    const doc = canvasDoc(VALID_SCENE_KEY)
    const res = normalizePageInput({
      title: "测试页面",
      contentJson: JSON.stringify(doc),
      contentHtml: "<p>画布前文本</p>",
      contentText: "画布前文本 系统架构图"
    })
    expect(res.ok).toBe(true)
  })

  it("normalizePageInput：合法的 sceneKey 与 previewKey 组合放行", () => {
    const doc = canvasDoc(VALID_SCENE_KEY, VALID_PREVIEW_KEY)
    const res = normalizePageInput({
      title: "测试页面",
      contentJson: JSON.stringify(doc),
      contentHtml: "<p>画布前文本</p>",
      contentText: "画布前文本 系统架构图"
    })
    expect(res.ok).toBe(true)
  })

  it("normalizePageInput：缺失 sceneKey 按 INVALID_CONTENT_JSON 拒绝", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "excalidraw",
          attrs: {
            extractedText: "缺少 sceneKey 的画布"
          }
        }
      ]
    }
    const res = normalizePageInput({
      title: "测试页面",
      contentJson: JSON.stringify(doc),
      contentHtml: "<p>内容</p>",
      contentText: "内容"
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe("INVALID_CONTENT_JSON")
      expect(res.error).toContain("sceneKey")
    }
  })

  it("normalizePageInput：非法格式 sceneKey 按 INVALID_CONTENT_JSON 拒绝", () => {
    const badKeys = [
      "not-a-key.json",
      "pages/not-uuid.json",
      "imports/a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d.json",
      "pages/a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d.png",
      "pages/A1B2C3D4-E5F6-4A1B-8C2D-3E4F5A6B7C8D.json"
    ]
    for (const badKey of badKeys) {
      const doc = canvasDoc(badKey)
      const res = normalizePageInput({
        title: "测试页面",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>内容</p>",
        contentText: "内容"
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe("INVALID_CONTENT_JSON")
      }
    }
  })

  it("normalizePageInput：非法格式 previewKey 按 INVALID_CONTENT_JSON 拒绝", () => {
    const badPreviewKeys = [
      "invalid-preview.png",
      "pages/not-uuid.png",
      "imports/f1e2d3c4-b5a6-4f1e-8d2c-3b4a5f6e7d8c.png",
      "pages/f1e2d3c4-b5a6-4f1e-8d2c-3b4a5f6e7d8c.jpg",
      "pages/F1E2D3C4-B5A6-4F1E-8D2C-3B4A5F6E7D8C.png"
    ]
    for (const badPreviewKey of badPreviewKeys) {
      const doc = canvasDoc(VALID_SCENE_KEY, badPreviewKey)
      const res = normalizePageInput({
        title: "测试页面",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>内容</p>",
        contentText: "内容"
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe("INVALID_CONTENT_JSON")
      }
    }
  })

  it("normalizeImportedContent：校验规则完全一致", () => {
    // 合法
    const okRes = normalizeImportedContent({
      title: "导入测试",
      contentJson: JSON.stringify(canvasDoc(VALID_SCENE_KEY))
    })
    expect(okRes.ok).toBe(true)

    // 非法 sceneKey
    const badSceneRes = normalizeImportedContent({
      title: "导入测试",
      contentJson: JSON.stringify(canvasDoc("invalid-scene"))
    })
    expect(badSceneRes.ok).toBe(false)
    if (!badSceneRes.ok) {
      expect(badSceneRes.code).toBe("INVALID_CONTENT_JSON")
    }

    // 非法 previewKey
    const badPreviewRes = normalizeImportedContent({
      title: "导入测试",
      contentJson: JSON.stringify(canvasDoc(VALID_SCENE_KEY, "bad-preview"))
    })
    expect(badPreviewRes.ok).toBe(false)
    if (!badPreviewRes.ok) {
      expect(badPreviewRes.code).toBe("INVALID_CONTENT_JSON")
    }
  })
})

describe("POST /api/pages/:id/canvas-preview 端点", () => {
  async function setup() {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const editor = await userSession(env, admin, "editor@example.com")
    const viewer = await userSession(env, admin, "viewer@example.com")
    const outsider = await userSession(env, admin, "outsider@example.com")

    const spaceRes = await jsonRequest(
      env,
      "POST",
      "/api/spaces",
      { name: "画布测试空间" },
      admin
    )
    const space = (await spaceRes.json()) as SpaceDto

    const meId = async (cookie: string) => {
      const me = (await (
        await jsonRequest(env, "GET", "/api/me", undefined, cookie)
      ).json()) as { id: string }
      return me.id
    }

    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: await meId(editor), role: "editor" },
      admin
    )
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: await meId(viewer), role: "viewer" },
      admin
    )

    return { env, admin, editor, viewer, outsider, space }
  }

  it("权限拦截：未登录 401、viewer 403、非成员 404、不存在页面 404", async () => {
    const { env, admin, viewer, outsider, space } = await setup()

    const doc = canvasDoc(VALID_SCENE_KEY)
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "权限测试页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 系统架构图"
      },
      admin
    )
    expect(pageRes.status).toBe(201)
    const page = (await pageRes.json()) as PageDetail

    const body = {
      sceneKey: VALID_SCENE_KEY,
      previewKey: VALID_PREVIEW_KEY
    }

    // 未登录 401
    const unauth = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      body,
      ""
    )
    expect(unauth.status).toBe(401)

    // viewer 403
    const forbidden = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      body,
      viewer
    )
    expect(forbidden.status).toBe(403)

    // 非成员 404
    const notFound = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      body,
      outsider
    )
    expect(notFound.status).toBe(404)

    // 页面不存在 404
    const nonExistent = await jsonRequest(
      env,
      "POST",
      "/api/pages/99999/canvas-preview",
      body,
      admin
    )
    expect(nonExistent.status).toBe(404)
  })

  it("参数校验：非法 body 400，非法/缺失 sceneKey 400，非法/缺失 previewKey 400", async () => {
    const { env, admin, space } = await setup()

    const doc = canvasDoc(VALID_SCENE_KEY)
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "参数校验页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 系统架构图"
      },
      admin
    )
    const page = (await pageRes.json()) as PageDetail

    // 非法/缺失 sceneKey
    const badScene = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { previewKey: VALID_PREVIEW_KEY },
      admin
    )
    expect(badScene.status).toBe(400)
    expect(await badScene.json()).toMatchObject({
      code: "INVALID_SCENE_KEY"
    })

    const badSceneFormat = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: "pages/bad.json", previewKey: VALID_PREVIEW_KEY },
      admin
    )
    expect(badSceneFormat.status).toBe(400)
    expect(await badSceneFormat.json()).toMatchObject({
      code: "INVALID_SCENE_KEY"
    })

    // 非法/缺失 previewKey
    const badPreview = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY },
      admin
    )
    expect(badPreview.status).toBe(400)
    expect(await badPreview.json()).toMatchObject({
      code: "INVALID_PREVIEW_KEY"
    })

    const badPreviewFormat = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY, previewKey: "pages/bad.png" },
      admin
    )
    expect(badPreviewFormat.status).toBe(400)
    expect(await badPreviewFormat.json()).toMatchObject({
      code: "INVALID_PREVIEW_KEY"
    })
  })

  it("画布未命中：当前正文无该 sceneKey 时回 404 CANVAS_NOT_FOUND", async () => {
    const { env, admin, space } = await setup()

    const doc = canvasDoc(VALID_SCENE_KEY)
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "未命中测试页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 系统架构图"
      },
      admin
    )
    const page = (await pageRes.json()) as PageDetail

    const otherSceneKey = "pages/99999999-9999-4999-8999-999999999999.json"
    const res = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: otherSceneKey, previewKey: VALID_PREVIEW_KEY },
      admin
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      code: "CANVAS_NOT_FOUND"
    })
  })

  it("成功回填：更新派生物、零版本增长、时间戳与作者保持不变", async () => {
    const { env, admin, editor, space } = await setup()
    const prefix = getTablePrefix(env)

    const doc = canvasDoc(VALID_SCENE_KEY, null, "架构全景图")
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "回填成功测试页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 架构全景图"
      },
      admin
    )
    expect(pageRes.status).toBe(201)
    const initialPage = (await pageRes.json()) as PageDetail

    // 记录初始数据库行状态
    const rowBefore = await getPageRow(env.DB, prefix, Number(initialPage.id))
    expect(rowBefore).not.toBeNull()
    if (!rowBefore) return

    // 初始 revisions 行数
    const revsBefore = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM ${prefix}page_revisions WHERE page_id = ?`
    )
      .bind(initialPage.id)
      .first<{ count: number }>()
    expect(revsBefore?.count).toBe(1)

    // 由 editor 发起回填
    const backfillRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${initialPage.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY, previewKey: VALID_PREVIEW_KEY },
      editor
    )
    expect(backfillRes.status).toBe(200)
    const backfillBody = await backfillRes.json()
    expect(backfillBody).toEqual({
      ok: true,
      status: "updated",
      sceneKey: VALID_SCENE_KEY,
      previewKey: VALID_PREVIEW_KEY
    })

    // 验证数据库状态
    const rowAfter = await getPageRow(env.DB, prefix, Number(initialPage.id))
    expect(rowAfter).not.toBeNull()
    if (!rowAfter) return

    // 零版本增长与时间戳/作者保护
    expect(rowAfter.updated_at).toBe(rowBefore.updated_at)
    expect(rowAfter.updated_by).toBe(rowBefore.updated_by)
    expect(rowAfter.created_at).toBe(rowBefore.created_at)
    expect(rowAfter.created_by).toBe(rowBefore.created_by)
    expect(rowAfter.title).toBe(rowBefore.title)

    // revisions 表保持仅 1 条版本
    const revsAfter = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM ${prefix}page_revisions WHERE page_id = ?`
    )
      .bind(initialPage.id)
      .first<{ count: number }>()
    expect(revsAfter?.count).toBe(1)

    // content_hash 改变并指向新内容
    expect(rowAfter.content_hash).not.toBe(rowBefore.content_hash)
    const updatedContent = await readContent(env, rowAfter.content_hash)
    expect(updatedContent).toContain(VALID_PREVIEW_KEY)

    // content_html 包含 previewKey 与 src
    expect(rowAfter.content_html).toContain(
      `data-preview-key="${VALID_PREVIEW_KEY}"`
    )
    expect(rowAfter.content_html).toContain(
      `src="/api/files/${VALID_PREVIEW_KEY}"`
    )

    // content_md 包含完整站点预览图链接
    expect(rowAfter.content_md).toContain(
      `![架构全景图](https://ciki.oneboy.app/api/files/${VALID_PREVIEW_KEY})`
    )

    // 幂等性验证：二次调用返回 already_filled，无任何写入
    const idempRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${initialPage.id}/canvas-preview`,
      {
        sceneKey: VALID_SCENE_KEY,
        previewKey: "pages/00000000-0000-4000-8000-000000000000.png"
      },
      editor
    )
    expect(idempRes.status).toBe(200)
    expect(await idempRes.json()).toEqual({
      ok: true,
      status: "already_filled",
      sceneKey: VALID_SCENE_KEY,
      previewKey: VALID_PREVIEW_KEY
    })

    // 再次核实 hash 与行未发生改变
    const rowFinal = await getPageRow(env.DB, prefix, Number(initialPage.id))
    expect(rowFinal?.content_hash).toBe(rowAfter.content_hash)
  })

  it("同页面多处相同 sceneKey 批量回填", async () => {
    const { env, admin, space } = await setup()

    const doc = {
      type: "doc",
      content: [
        {
          type: "excalidraw",
          attrs: {
            sceneKey: VALID_SCENE_KEY,
            extractedText: "副本1"
          }
        },
        {
          type: "excalidraw",
          attrs: {
            sceneKey: VALID_SCENE_KEY,
            extractedText: "副本2"
          }
        }
      ]
    }

    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "多副本画布页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>内容</p>",
        contentText: "副本1 副本2"
      },
      admin
    )
    const page = (await pageRes.json()) as PageDetail

    const backfillRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY, previewKey: VALID_PREVIEW_KEY },
      admin
    )
    expect(backfillRes.status).toBe(200)
    expect(await backfillRes.json()).toEqual({
      ok: true,
      status: "updated",
      sceneKey: VALID_SCENE_KEY,
      previewKey: VALID_PREVIEW_KEY
    })

    const prefix = getTablePrefix(env)
    const row = await getPageRow(env.DB, prefix, Number(page.id))
    const updatedContent = JSON.parse(await readContent(env, row!.content_hash))
    for (const node of updatedContent.content) {
      expect(node.attrs.previewKey).toBe(VALID_PREVIEW_KEY)
    }
  })

  it("并发冲突 CAS：第一次碰撞后重试成功", async () => {
    const { env, admin, space } = await setup()
    const prefix = getTablePrefix(env)

    const doc = canvasDoc(VALID_SCENE_KEY)
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "CAS 重试成功测试页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 系统架构图"
      },
      admin
    )
    const page = (await pageRes.json()) as PageDetail

    const concurrentDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "并发修改文本" }]
        },
        {
          type: "excalidraw",
          attrs: { sceneKey: VALID_SCENE_KEY, extractedText: "系统架构图" }
        }
      ]
    }
    const concurrentJson = JSON.stringify(concurrentDoc)
    const concurrentHash = await hashContent(concurrentJson)
    await putContentHashed(env, concurrentHash, concurrentJson)

    const originalPut = env.CONTENT.put.bind(env.CONTENT)
    let putCalls = 0
    env.CONTENT.put = (async (key: string, value: any, options?: any) => {
      putCalls++
      if (putCalls === 1) {
        await env.DB.prepare(
          `UPDATE ${prefix}pages SET content_hash = ? WHERE id = ?`
        )
          .bind(concurrentHash, page.id)
          .run()
      }
      return originalPut(key, value, options)
    }) as any

    const backfillRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY, previewKey: VALID_PREVIEW_KEY },
      admin
    )

    expect(backfillRes.status).toBe(200)
    expect(await backfillRes.json()).toEqual({
      ok: true,
      status: "updated",
      sceneKey: VALID_SCENE_KEY,
      previewKey: VALID_PREVIEW_KEY
    })
    expect(putCalls).toBe(2)
  })

  it("并发冲突 CAS：重试依然碰撞返回 409 CONCURRENT_COLLISION", async () => {
    const { env, admin, space } = await setup()
    const prefix = getTablePrefix(env)

    const doc = canvasDoc(VALID_SCENE_KEY)
    const pageRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        spaceId: space.id,
        title: "CAS 409 测试页",
        contentJson: JSON.stringify(doc),
        contentHtml: "<p>画布前文本</p>",
        contentText: "画布前文本 系统架构图"
      },
      admin
    )
    const page = (await pageRes.json()) as PageDetail

    const concurrentDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "并发修改文本" }]
        },
        {
          type: "excalidraw",
          attrs: { sceneKey: VALID_SCENE_KEY, extractedText: "系统架构图" }
        }
      ]
    }
    const concurrentJson = JSON.stringify(concurrentDoc)
    const concurrentHash = await hashContent(concurrentJson)
    await putContentHashed(env, concurrentHash, concurrentJson)

    const concurrentDoc2 = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "并发修改文本2" }]
        },
        {
          type: "excalidraw",
          attrs: { sceneKey: VALID_SCENE_KEY, extractedText: "系统架构图" }
        }
      ]
    }
    const concurrentJson2 = JSON.stringify(concurrentDoc2)
    const concurrentHash2 = await hashContent(concurrentJson2)
    await putContentHashed(env, concurrentHash2, concurrentJson2)

    const originalPut = env.CONTENT.put.bind(env.CONTENT)
    let putCalls = 0
    env.CONTENT.put = (async (key: string, value: any, options?: any) => {
      putCalls++
      if (putCalls === 1) {
        await env.DB.prepare(
          `UPDATE ${prefix}pages SET content_hash = ? WHERE id = ?`
        )
          .bind(concurrentHash2, page.id)
          .run()
      } else if (putCalls === 2) {
        await env.DB.prepare(
          `UPDATE ${prefix}pages SET content_hash = ? WHERE id = ?`
        )
          .bind("concurrent-collided-hash", page.id)
          .run()
      }
      return originalPut(key, value, options)
    }) as any

    const backfillRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/canvas-preview`,
      { sceneKey: VALID_SCENE_KEY, previewKey: VALID_PREVIEW_KEY },
      admin
    )

    expect(backfillRes.status).toBe(409)
    expect(await backfillRes.json()).toMatchObject({
      code: "CONCURRENT_COLLISION"
    })
    expect(putCalls).toBe(2)
  })
})
