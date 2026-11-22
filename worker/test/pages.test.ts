import { describe, expect, it } from "vitest"
import { DELETED_AUTHOR_NAME } from "../src/routes/comments"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

/** 一段正文的自洽夹具：JSON 是版本的唯一真源，HTML/纯文本是它的渲染结果。 */
function paragraphDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  })
}

interface PageDetail {
  id: string
  parentId: string | null
  title: string
  contentHtml: string
  contentJson: string
  contentText: string
  createdBy: number
  createdByName: string | null
  createdByAvatarUrl: string | null
  updatedBy: number
  updatedByName: string | null
  updatedByAvatarUrl: string | null
  updatedAt: string
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

async function getDetail(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  id: string
): Promise<PageDetail> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/pages/${id}`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as PageDetail
}

async function revisionList(
  env: Parameters<typeof adminSession>[0],
  cookie: string,
  pageId: string
): Promise<Array<{ versionNo: number; title: string }>> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/pages/${pageId}/revisions`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{ versionNo: number; title: string }>
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
    ).json()) as Array<{ versionNo: number; title: string }>
    expect(revisions.map((revision) => revision.title)).toEqual([
      "第二版",
      "第一版"
    ])

    const oldest = revisions[revisions.length - 1]
    const restore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${oldest.versionNo}/restore`,
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

describe("页面：无改动保存不新增 revision", () => {
  it("同内容连存三次：不新增 revision、updatedAt 不变、响应同形", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, { title: "无改动页" })
    const before = await getDetail(env, admin, page.id)

    const payload = {
      title: "无改动页",
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: "<p>无改动页</p>",
      contentText: "无改动页"
    }
    for (let i = 0; i < 3; i += 1) {
      const res = await jsonRequest(
        env,
        "PUT",
        `/api/pages/${page.id}`,
        payload,
        admin
      )
      expect(res.status).toBe(200)
      const saved = (await res.json()) as PageDetail
      // 响应与正常保存同形：完整详情，只是时间/编辑人保持原值。
      expect(saved.id).toBe(page.id)
      expect(saved.title).toBe(before.title)
      expect(saved.contentHtml).toBe(before.contentHtml)
      expect(saved.contentText).toBe(before.contentText)
      expect(saved.updatedAt).toBe(before.updatedAt)
      expect(saved.updatedBy).toBe(before.updatedBy)
    }

    const after = await getDetail(env, admin, page.id)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(await revisionList(env, admin, page.id)).toHaveLength(1)
  })

  it("改一个字 → 正常保存，revision +1", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, { title: "改字页" })

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "改字页",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>改字页。</p>",
        contentText: "改字页。"
      },
      admin
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as PageDetail
    expect(saved.contentText).toBe("改字页。")

    const revisions = await revisionList(env, admin, page.id)
    expect(revisions).toHaveLength(2)
    expect(revisions[0].title).toBe("改字页")
  })

  it("仅改标题 → 不长版本：原地改 title、同步搜索索引、内容对象不增", async () => {
    const { env, content } = await initializedContext()
    const admin = await adminSession(env)
    // 正文固定不包含标题，避免旧标题从正文里被搜到，影响索引断言。
    const page = await createPage(env, admin, {
      title: "原标题",
      contentHtml: "<p>正文固定</p>",
      contentText: "正文固定"
    })
    const objectsBefore = content.store.size
    const before = await getDetail(env, admin, page.id)

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "新标题",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>正文固定</p>",
        contentText: "正文固定"
      },
      admin
    )
    expect(res.status).toBe(200)
    const saved = (await res.json()) as PageDetail
    expect(saved.title).toBe("新标题")
    // 正文没动，就只有标题与更新时间变。
    expect(saved.contentHtml).toBe("<p>正文固定</p>")
    expect(saved.updatedAt).not.toBe(before.updatedAt)

    // 改名是页级元数据：不产新版本，也不新增内容对象。
    expect(await revisionList(env, admin, page.id)).toHaveLength(1)
    expect(content.store.size).toBe(objectsBefore)

    // 标题在搜索索引里：旧标题搜不到，新标题能搜到。
    const found = await jsonRequest(
      env,
      "GET",
      `/api/search?q=${encodeURIComponent("新标题")}`,
      undefined,
      admin
    )
    expect(found.status).toBe(200)
    expect(
      ((await found.json()) as { results: Array<{ pageId: number }> }).results
    ).toEqual([expect.objectContaining({ pageId: page.id })])
    const stale = await jsonRequest(
      env,
      "GET",
      `/api/search?q=${encodeURIComponent("原标题")}`,
      undefined,
      admin
    )
    expect(
      ((await stale.json()) as { results: unknown[] }).results
    ).toHaveLength(0)

    // 下一次真改正文：照常 +1 条版本，标题跟着落新版本。
    const edited = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "新标题",
        contentJson: paragraphDoc("改过的正文"),
        contentHtml: "<p>改过的正文</p>",
        contentText: "改过的正文"
      },
      admin
    )
    expect(edited.status).toBe(200)
    const revisions = await revisionList(env, admin, page.id)
    expect(revisions).toHaveLength(2)
    expect(revisions[0]).toMatchObject({ versionNo: 2, title: "新标题" })
  })

  it("回滚到与当前全等的版本：不新增 revision、updatedAt 不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const page = await createPage(env, admin, { title: "回滚页" })

    const edited = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "回滚页",
        contentJson: paragraphDoc("改过的正文"),
        contentHtml: "<p>改过的正文</p>",
        contentText: "改过的正文"
      },
      admin
    )
    expect(edited.status).toBe(200)

    const before = await getDetail(env, admin, page.id)
    const revisions = await revisionList(env, admin, page.id)
    expect(revisions).toHaveLength(2)

    // revisions[0] 就是当前版本：拿它回滚应当判定为无改动。
    const restore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${revisions[0].versionNo}/restore`,
      undefined,
      admin
    )
    expect(restore.status).toBe(200)
    const restored = (await restore.json()) as PageDetail
    expect(restored.title).toBe(before.title)
    expect(restored.contentHtml).toBe(before.contentHtml)
    expect(restored.contentText).toBe(before.contentText)
    expect(restored.updatedAt).toBe(before.updatedAt)
    expect(await revisionList(env, admin, page.id)).toHaveLength(2)
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

describe("页面：parentId 归一（同一类入口）", () => {
  it('新建传空串按根页入库；移动传空串移到根，绝不写 parent_id=""', async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)

    const created = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "空串父页",
        parentId: "",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "",
        contentText: ""
      },
      admin
    )
    expect(created.status).toBe(201)
    const page = (await created.json()) as PageDetail
    expect(page.parentId).toBeNull()
    const stored = db.db
      .prepare("SELECT parent_id FROM ciki_pages WHERE id = ?")
      .get(page.id) as { parent_id: string | null }
    expect(stored.parent_id).toBeNull()

    const parent = await createPage(env, admin, { title: "父页" })
    const child = await createPage(env, admin, {
      title: "子页",
      parentId: parent.id
    })
    const moved = await jsonRequest(
      env,
      "POST",
      `/api/pages/${child.id}/move`,
      { parentId: "" },
      admin
    )
    expect(moved.status).toBe(200)
    const after = db.db
      .prepare("SELECT parent_id FROM ciki_pages WHERE id = ?")
      .get(child.id) as { parent_id: string | null }
    expect(after.parent_id).toBeNull()

    const tree = (await (
      await jsonRequest(env, "GET", "/api/pages", undefined, admin)
    ).json()) as Array<{ id: string; children: Array<{ id: string }> }>
    const root = tree.find((row) => row.id === child.id)
    expect(root).toBeTruthy()
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

describe("页面：空间角色权限", () => {
  it("editor 可编辑/删除/回滚他人页面；viewer 只读", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const user = await userSession(env, admin)
    const viewer = await userSession(env, admin, "viewer@example.com")

    const spaces = (await (
      await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
    ).json()) as Array<{ id: string; isDefault: boolean }>
    const space = spaces.find((row) => row.isDefault)
    expect(space).toBeTruthy()

    const viewerMe = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, viewer)
    ).json()) as { id: string }
    const added = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space?.id}/members/${viewerMe.id}`,
      { role: "viewer" },
      admin
    )
    expect(added.status).toBe(200)

    const page = await createPage(env, admin, { title: "管理员的页面" })

    const viewerEdit = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "viewer 改",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>改过</p>",
        contentText: "改过"
      },
      viewer
    )
    expect(viewerEdit.status).toBe(403)

    const viewerDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      viewer
    )
    expect(viewerDelete.status).toBe(403)

    const viewerRevisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        viewer
      )
    ).json()) as Array<{ id: string }>
    const viewerRestore = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${viewerRevisions[0].versionNo}/restore`,
      undefined,
      viewer
    )
    expect(viewerRestore.status).toBe(403)

    const edit = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "被 editor 编辑",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>改过</p>",
        contentText: "改过"
      },
      user
    )
    expect(edit.status).toBe(200)

    const deleted = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}`,
      undefined,
      user
    )
    expect(deleted.status).toBe(200)

    const restored = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/restore`,
      undefined,
      user
    )
    expect(restored.status).toBe(200)

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        user
      )
    ).json()) as Array<{ id: string }>
    const rolledBack = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${revisions[revisions.length - 1].versionNo}/restore`,
      undefined,
      user
    )
    expect(rolledBack.status).toBe(200)
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

describe("页面：原始输入粗筛不误伤消毒后合规的内容", () => {
  it("原始 HTML / contentText 超过契约上限、但规范化后很小 → 201", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    // 原始 HTML ≈960KB（> 契约 800KB），注释被消毒剥掉后只剩 <p>ok</p>。
    const html = `${"<!--x-->".repeat(120_000)}<p>ok</p>`
    // 原始 contentText ≈1.26M 字符（> 旧的 1.2M 粗筛），全是空标签、规范化后为空。
    const contentText = "<b></b>".repeat(180_000)

    const res = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "大输入小结果",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: html,
        contentText
      },
      admin
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      contentHtml: string
      contentText: string
    }
    expect(body.contentHtml).not.toContain("<!--")
    expect(body.contentHtml).toContain("<p>ok</p>")
    expect(body.contentText).toBe("")
  })
})

describe("页面：新建失败不留半成品", () => {
  it("版本+索引这一批失败时，刚插入的页面行被收回", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env)
    // 让新建的第二步（版本 + 索引）必然失败：版本行插入被触发器打断。
    db.db.exec(
      `CREATE TRIGGER fail_revision_insert BEFORE INSERT ON ciki_page_revisions
         BEGIN SELECT RAISE(ABORT, 'revision insert blocked'); END`
    )

    const res = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "建不成的页",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>正文</p>",
        contentText: "正文"
      },
      admin
    )
    expect(res.status).toBe(500)

    const count = (sql: string) =>
      (db.db.prepare(sql).get() as { count: number }).count
    expect(count("SELECT COUNT(*) AS count FROM ciki_pages")).toBe(0)
    expect(count("SELECT COUNT(*) AS count FROM ciki_page_revisions")).toBe(0)
    expect(count("SELECT COUNT(*) AS count FROM ciki_pages_fts")).toBe(0)
  })
})

describe("页面：作者信息解析与回退", () => {
  async function meId(
    env: Parameters<typeof adminSession>[0],
    cookie: string
  ): Promise<number> {
    const res = await jsonRequest(env, "GET", "/api/me", undefined, cookie)
    const me = (await res.json()) as { id: number }
    return me.id
  }

  it("正常用户（有头像与无头像）：POST /、GET /:id、GET /:id?format=json、PUT /:id", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const aliceId = await meId(env, admin)
    // 设置 alice 的头像
    db.db
      .prepare("UPDATE ciki_users SET avatar_key = ? WHERE id = ?")
      .run("avatars/alice.png", aliceId)

    const bob = await userSession(env, admin, "bob@example.com")
    const bobId = await meId(env, bob)
    // bob 没有头像，给 bob 赋予默认空间的 editor 角色
    await jsonRequest(
      env,
      "POST",
      "/api/spaces/1/members",
      { userId: bobId, role: "editor" },
      admin
    )

    // 1. POST /api/pages 创建
    const createRes = await jsonRequest(
      env,
      "POST",
      "/api/pages",
      {
        title: "作者解析测试页",
        parentId: null,
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>初版内容</p>",
        contentText: "初版内容"
      },
      admin
    )
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as PageDetail
    expect(created.createdBy).toBe(aliceId)
    expect(created.createdByName).toBe("alice")
    expect(created.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(created.updatedBy).toBe(aliceId)
    expect(created.updatedByName).toBe("alice")
    expect(created.updatedByAvatarUrl).toBe("/api/files/avatars/alice.png")

    // 2. GET /api/pages/:id
    const getRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${created.id}`,
      undefined,
      admin
    )
    expect(getRes.status).toBe(200)
    const detail = (await getRes.json()) as PageDetail
    expect(detail.createdBy).toBe(aliceId)
    expect(detail.createdByName).toBe("alice")
    expect(detail.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(detail.updatedBy).toBe(aliceId)
    expect(detail.updatedByName).toBe("alice")
    expect(detail.updatedByAvatarUrl).toBe("/api/files/avatars/alice.png")

    // 3. GET /api/pages/:id?format=json
    const jsonRes = await jsonRequest(
      env,
      "GET",
      `/api/pages/${created.id}?format=json`,
      undefined,
      admin
    )
    expect(jsonRes.status).toBe(200)
    const jsonDetail = (await jsonRes.json()) as PageDetail & {
      contentJson: string
    }
    expect(jsonDetail.contentJson).toBe(JSON.stringify({ type: "doc" }))
    expect(jsonDetail.createdBy).toBe(aliceId)
    expect(jsonDetail.createdByName).toBe("alice")
    expect(jsonDetail.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(jsonDetail.updatedBy).toBe(aliceId)
    expect(jsonDetail.updatedByName).toBe("alice")
    expect(jsonDetail.updatedByAvatarUrl).toBe("/api/files/avatars/alice.png")

    // 4. PUT /api/pages/:id 由 bob 更新
    const updateRes = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${created.id}`,
      {
        title: "作者解析测试页-二版",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>二版内容</p>",
        contentText: "二版内容"
      },
      bob
    )
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as PageDetail
    expect(updated.createdBy).toBe(aliceId)
    expect(updated.createdByName).toBe("alice")
    expect(updated.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(updated.updatedBy).toBe(bobId)
    expect(updated.updatedByName).toBe("bob")
    expect(updated.updatedByAvatarUrl).toBeNull()

    // 再次 GET 验证保持一致
    const afterUpdate = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${created.id}`,
        undefined,
        admin
      )
    ).json()) as PageDetail
    expect(afterUpdate.createdByName).toBe("alice")
    expect(afterUpdate.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(afterUpdate.updatedByName).toBe("bob")
    expect(afterUpdate.updatedByAvatarUrl).toBeNull()
  })

  it("播种页面（created_by / updated_by = 0）：名字与头像皆为 null，更新后 updater 正确解析", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const aliceId = await meId(env, admin)
    const page = await createPage(env, admin, {
      title: "播种页面",
      contentHtml: "<p>播种正文</p>",
      contentText: "播种正文"
    })

    // 模拟存量播种页面：created_by 与 updated_by 均为 0
    db.db
      .prepare(
        "UPDATE ciki_pages SET created_by = 0, updated_by = 0 WHERE id = ?"
      )
      .run(page.id)

    const seededDetail = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as PageDetail
    expect(seededDetail.createdBy).toBe(0)
    expect(seededDetail.createdByName).toBeNull()
    expect(seededDetail.createdByAvatarUrl).toBeNull()
    expect(seededDetail.updatedBy).toBe(0)
    expect(seededDetail.updatedByName).toBeNull()
    expect(seededDetail.updatedByAvatarUrl).toBeNull()

    // alice 更新播种页面：createdBy 保持 0 与 null，updatedBy 解析为 alice
    const updatedRes = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "播种页面-更新后",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>新内容</p>",
        contentText: "新内容"
      },
      admin
    )
    expect(updatedRes.status).toBe(200)
    const updatedDetail = (await updatedRes.json()) as PageDetail
    expect(updatedDetail.createdBy).toBe(0)
    expect(updatedDetail.createdByName).toBeNull()
    expect(updatedDetail.createdByAvatarUrl).toBeNull()
    expect(updatedDetail.updatedBy).toBe(aliceId)
    expect(updatedDetail.updatedByName).toBe("alice")
    expect(updatedDetail.updatedByAvatarUrl).toBeNull()
  })

  it("已注销用户：回退到「已注销用户」，头像为 null", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const charlie = await userSession(env, admin, "charlie@example.com")
    const charlieId = await meId(env, charlie)
    await jsonRequest(
      env,
      "POST",
      "/api/spaces/1/members",
      { userId: charlieId, role: "editor" },
      admin
    )

    const charliePage = await createPage(env, charlie, {
      title: "查理的页面",
      contentHtml: "<p>查理写的正文</p>",
      contentText: "查理写的正文"
    })

    // 管理员彻底删除 charlie
    db.db.prepare("DELETE FROM ciki_users WHERE id = ?").run(charlieId)

    const detail = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${charliePage.id}`,
        undefined,
        admin
      )
    ).json()) as PageDetail
    expect(detail.createdBy).toBe(charlieId)
    expect(detail.createdByName).toBe(DELETED_AUTHOR_NAME)
    expect(detail.createdByAvatarUrl).toBeNull()
    expect(detail.updatedBy).toBe(charlieId)
    expect(detail.updatedByName).toBe(DELETED_AUTHOR_NAME)
    expect(detail.updatedByAvatarUrl).toBeNull()
  })

  it("版本回滚（restore）：响应详情与 GET /api/pages/:id 严格对齐，updatedBy 指向回滚执行者", async () => {
    const { env, db } = await initializedContext()
    const admin = await adminSession(env, "alice@example.com")
    const aliceId = await meId(env, admin)
    db.db
      .prepare("UPDATE ciki_users SET avatar_key = ? WHERE id = ?")
      .run("avatars/alice.png", aliceId)

    const bob = await userSession(env, admin, "bob@example.com")
    const bobId = await meId(env, bob)
    await jsonRequest(
      env,
      "POST",
      "/api/spaces/1/members",
      { userId: bobId, role: "editor" },
      admin
    )

    // Alice 创建版本 1
    const page = await createPage(env, admin, {
      title: "回滚对齐页",
      contentHtml: "<p>初版</p>",
      contentText: "初版"
    })

    // Bob 更新为版本 2
    await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "回滚对齐页-二版",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>二版</p>",
        contentText: "二版"
      },
      bob
    )

    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ versionNo: number }>
    const oldest = revisions[revisions.length - 1]

    // Alice 执行版本回滚
    const restoreRes = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${oldest.versionNo}/restore`,
      undefined,
      admin
    )
    expect(restoreRes.status).toBe(200)
    const restored = (await restoreRes.json()) as PageDetail

    expect(restored.createdBy).toBe(aliceId)
    expect(restored.createdByName).toBe("alice")
    expect(restored.createdByAvatarUrl).toBe("/api/files/avatars/alice.png")
    expect(restored.updatedBy).toBe(aliceId)
    expect(restored.updatedByName).toBe("alice")
    expect(restored.updatedByAvatarUrl).toBe("/api/files/avatars/alice.png")

    // 回滚返回的详情与最新 GET /api/pages/:id 完全一致（字段与数值同形）
    const freshGet = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as PageDetail
    expect(restored).toEqual(freshGet)
  })
})
