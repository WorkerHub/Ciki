import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

interface PageDetail {
  id: string
  parentId: string | null
  title: string
  contentHtml: string
  contentJson: string
  contentText: string
  createdBy: string
}

async function createPage(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  input: {
    title: string
    parentId?: string | null
    contentHtml?: string
    contentText?: string
  }
): Promise<PageDetail> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title: input.title,
      parentId: input.parentId ?? null,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: input.contentHtml ?? `<p>${input.title}</p>`,
      contentText: input.contentText ?? input.title
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as PageDetail
}

describe("页面：新建、详情、树与消毒", () => {
  it("保存时服务端二次消毒：剥 script/on*，外链图片降级为未转存标记", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const page = await createPage(env, admin, {
      title: "首页",
      contentHtml:
        '<p onclick="x">正文</p><script>alert(1)</script>' +
        '<img src="https://confluence.example/download/a.png" onerror="alert(1)">' +
        '<table><tr><td colspan="2">合并</td></tr></table>' +
        '<pre><code class="language-sql">select 1</code></pre>',
      contentText: "正文"
    })

    expect(page.contentHtml).not.toContain("<script")
    expect(page.contentHtml).not.toContain("onerror")
    expect(page.contentHtml).not.toContain("onclick")
    expect(page.contentHtml).toContain(
      'data-original-src="https://confluence.example/download/a.png"'
    )
    expect(page.contentHtml).toContain('data-confluence-img="true"')
    expect(page.contentHtml).toContain('colspan="2"')
    expect(page.contentHtml).toContain('class="language-sql"')

    const tree = (await (
      await jsonRequest(env, "GET", "/api/pages", undefined, admin)
    ).json()) as Array<{ id: string; title: string; children: unknown[] }>
    expect(tree).toHaveLength(1)
    expect(tree[0].title).toBe("首页")
  })

  it("新建即生成 revision；保存追加 revision；可回滚旧版并生成新 revision", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, { title: "第一版" })

    const updated = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "第二版",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>第二版</p>",
        contentText: "第二版"
      },
      admin
    )
    expect(updated.status).toBe(200)

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string; title: string }>
    expect(revisions.map((revision) => revision.title)).toEqual([
      "第二版",
      "第一版"
    ])

    const oldest = revisions[revisions.length - 1]
    const restore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${oldest.id}/restore`,
      undefined,
      admin
    )
    expect(restore.status).toBe(200)
    expect(((await restore.json()) as PageDetail).title).toBe("第一版")

    const after = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ title: string }>
    expect(after).toHaveLength(3)
    expect(after[0].title).toBe("第一版")
  })
})

describe("页面：移动与环检测", () => {
  it("移入自身子树 409；移到根与换父成功并重排 sortOrder", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const a = await createPage(env, admin, { title: "A" })
    const b = await createPage(env, admin, { title: "B" })
    const c = await createPage(env, admin, { title: "C", parentId: a.id })

    const cycle = await jsonRequest(
      env,
      "POST",
      `/api/pages/${a.id}/move`,
      { parentId: c.id },
      admin
    )
    expect(cycle.status).toBe(409)
    expect(await cycle.json()).toMatchObject({ code: "PAGE_MOVE_CYCLE" })

    const toRoot = await jsonRequest(
      env,
      "POST",
      `/api/pages/${c.id}/move`,
      { parentId: null },
      admin
    )
    expect(toRoot.status).toBe(200)

    const underA = await jsonRequest(
      env,
      "POST",
      `/api/pages/${b.id}/move`,
      { parentId: a.id, sortOrder: 0 },
      admin
    )
    expect(underA.status).toBe(200)

    const tree = (await (
      await jsonRequest(env, "GET", "/api/pages", undefined, admin)
    ).json()) as Array<{
      id: string
      sortOrder: number
      children: Array<{ id: string; sortOrder: number }>
    }>
    const rootIds = tree.map((node) => node.id).sort()
    expect(rootIds).toEqual([a.id, c.id].sort())
    const aNode = tree.find((node) => node.id === a.id)!
    expect(aNode.children.map((child) => child.id)).toEqual([b.id])
    expect(aNode.children[0].sortOrder).toBe(0)
  })
})

describe("页面：软删级联、回收站、恢复与彻底删", () => {
  it("删父页级联子树；回收站只列根；恢复同一批；彻底删清干净", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    const parent = await createPage(env, admin, { title: "父页" })
    const child = await createPage(env, admin, {
      title: "子页",
      parentId: parent.id
    })

    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )
    expect(removed.status).toBe(200)
    expect(
      (
        await jsonRequest(
          env,
          "GET",
          `/api/pages/${child.id}`,
          undefined,
          admin
        )
      ).status
    ).toBe(404)

    const trash = (await (
      await jsonRequest(env, "GET", "/api/pages/trash", undefined, admin)
    ).json()) as Array<{ id: string }>
    expect(trash.map((item) => item.id)).toEqual([parent.id])

    const restore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${parent.id}/restore`,
      undefined,
      admin
    )
    expect(restore.status).toBe(200)
    expect(
      (
        await jsonRequest(
          env,
          "GET",
          `/api/pages/${child.id}`,
          undefined,
          admin
        )
      ).status
    ).toBe(200)

    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )
    const permanent = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}/permanent`,
      undefined,
      admin
    )
    expect(permanent.status).toBe(200)

    const rows = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_pages")
      .get() as { count: number }
    expect(rows.count).toBe(0)
    const revisions = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_page_revisions")
      .get() as { count: number }
    expect(revisions.count).toBe(0)
    const fts = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_pages_fts")
      .get() as { count: number }
    expect(fts.count).toBe(0)
  })

  it("未软删就彻底删 409；父页仍在回收站时恢复子页 409", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const parent = await createPage(env, admin, { title: "父页" })
    const child = await createPage(env, admin, {
      title: "子页",
      parentId: parent.id
    })

    const notDeleted = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}/permanent`,
      undefined,
      admin
    )
    expect(notDeleted.status).toBe(409)
    expect(await notDeleted.json()).toMatchObject({ code: "PAGE_NOT_DELETED" })

    // 先单独删子页（批次 1），再删父页（批次 2）
    await jsonRequest(env, "DELETE", `/api/pages/${child.id}`, undefined, admin)
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${parent.id}`,
      undefined,
      admin
    )

    const blocked = await jsonRequest(
      env,
      "POST",
      `/api/pages/${child.id}/restore`,
      undefined,
      admin
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: "PARENT_DELETED" })
  })
})

describe("页面：作者/管理员权限", () => {
  it("登录用户可编辑任何页面；删除与回滚限作者或管理员", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const page = await createPage(env, admin, { title: "管理员的页面" })

    const edit = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "被普通用户编辑",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>改过</p>",
        contentText: "改过"
      },
      user
    )
    expect(edit.status).toBe(200)

    const deleteDenied = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      user
    )
    expect(deleteDenied.status).toBe(403)

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        user
      )
    ).json()) as Array<{ id: string }>
    const restoreDenied = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${revisions[0].id}/restore`,
      undefined,
      user
    )
    expect(restoreDenied.status).toBe(403)

    const deleteAllowed = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      admin
    )
    expect(deleteAllowed.status).toBe(200)
  })

  it("未登录访问页面接口 401", async () => {
    const { env } = await initializedContext()
    const res = await request(env, "/api/pages")
    expect(res.status).toBe(401)
  })
})

describe("页面：保存体积以消毒后的结果为准", () => {
  it("外链图片消毒后膨胀超限 → 413 + PAYLOAD_TOO_LARGE", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 原始 ≈390KB（低于粗筛阈值），消毒后每个 img 变成两个属性，膨胀到 >800KB。
    const html = '<img src="x">'.repeat(30_000)
    const res = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "图片很多",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: html,
        contentText: "图片很多"
      },
      admin
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({
      error: "Payload too large",
      code: "PAYLOAD_TOO_LARGE"
    })
  })

  it("少量外链图片正常保存；contentHtml 已按消毒后结果入库", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const res = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "少量图片",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: '<img src="https://confluence.example/a.png">'.repeat(3),
        contentText: "少量图片"
      },
      admin
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { contentHtml: string }
    expect((body.contentHtml.match(/data-original-src/g) ?? []).length).toBe(3)
  })
})
