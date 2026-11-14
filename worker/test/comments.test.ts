/**
 * 页尾评论 API（规格「Ciki 页尾评论」§一/§二/§四）：权限矩阵、串行为、软删呈现、
 * 计数、Markdown 与预览、以及和页面的联动（回滚 / 回收站 / 彻底删除）。
 */
import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"

interface CommentDto {
  id: string
  parentId: string | null
  authorId: string
  authorName: string
  authorAvatarUrl: string | null
  bodyMd: string
  html: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  canEdit: boolean
  canDelete: boolean
  replies?: CommentDto[]
}

interface ThreadsBody {
  total: number
  threads: CommentDto[]
}

type Env = Parameters<typeof adminSession>[0]

async function createSpace(
  env: Env,
  cookie: string,
  name: string
): Promise<{ id: string }> {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function meId(env: Env, cookie: string): Promise<string> {
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  ).json()) as { id: string }
  return me.id
}

async function addMember(
  env: Env,
  admin: string,
  spaceId: string,
  cookie: string,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId: await meId(env, cookie), role },
    admin
  )
  expect(res.status).toBe(201)
}

async function createPage(
  env: Env,
  cookie: string,
  title: string,
  spaceId: string
): Promise<{ id: string }> {
  const res = await jsonRequest(
    env,
    "POST",
    "/api/pages",
    {
      title,
      spaceId,
      parentId: null,
      contentJson: JSON.stringify({ type: "doc" }),
      contentHtml: `<p>${title}</p>`,
      contentText: title
    },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function listComments(
  env: Env,
  cookie: string | undefined,
  pageId: string
): Promise<ThreadsBody> {
  const res = await jsonRequest(
    env,
    "GET",
    `/api/pages/${pageId}/comments`,
    undefined,
    cookie
  )
  expect(res.status).toBe(200)
  return (await res.json()) as ThreadsBody
}

async function postComment(
  env: Env,
  cookie: string | undefined,
  pageId: string,
  body: { bodyMd?: unknown; parentId?: string | null }
) {
  return jsonRequest(env, "POST", `/api/pages/${pageId}/comments`, body, cookie)
}

async function createComment(
  env: Env,
  cookie: string,
  pageId: string,
  bodyMd: string,
  parentId: string | null = null
): Promise<CommentDto> {
  const res = await postComment(env, cookie, pageId, { bodyMd, parentId })
  expect(res.status).toBe(201)
  return (await res.json()) as CommentDto
}

async function scenario() {
  const context = await initializedContext()
  const { env, db } = context
  const admin = await adminSession(env)
  const author = await userSession(env, admin, "author@example.com")
  const other = await userSession(env, admin, "other@example.com")
  const viewer = await userSession(env, admin, "viewer@example.com")
  const spaceAdmin = await userSession(env, admin, "space-admin@example.com")

  const space = await createSpace(env, admin, "评论空间")
  await addMember(env, admin, space.id, author, "editor")
  await addMember(env, admin, space.id, other, "editor")
  await addMember(env, admin, space.id, viewer, "viewer")
  await addMember(env, admin, space.id, spaceAdmin, "admin")

  const page = await createPage(env, admin, "评论页", space.id)
  return {
    context,
    env,
    db,
    admin,
    author,
    other,
    viewer,
    spaceAdmin,
    space,
    page
  }
}

describe("评论：读与发表权限", () => {
  it("viewer 能列表能发表；非成员 404；未登录 401；已软删页面 404", async () => {
    const { env, admin, viewer, spaceAdmin, space, page } = await scenario()

    const empty = await listComments(env, viewer, page.id)
    expect(empty).toEqual({ total: 0, threads: [] })

    const posted = await postComment(env, viewer, page.id, {
      bodyMd: "viewer 的第一条"
    })
    expect(posted.status).toBe(201)

    // 非成员：把他移出空间后，读/写都与页面同口径 404（不泄露页面存在性）。
    const removed = await jsonRequest(
      env,
      "DELETE",
      `/api/spaces/${space.id}/members/${await meId(env, viewer)}`,
      undefined,
      spaceAdmin
    )
    expect(removed.status).toBe(200)
    const outsiderGet = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      viewer
    )
    expect(outsiderGet.status).toBe(404)
    const outsiderPost = await postComment(env, viewer, page.id, {
      bodyMd: "越权"
    })
    expect(outsiderPost.status).toBe(404)
    // 移出之后连页面本身也 404，口径一致。
    expect(
      (
        await jsonRequest(
          env,
          "GET",
          `/api/pages/${page.id}`,
          undefined,
          viewer
        )
      ).status
    ).toBe(404)

    // 未登录。
    const anonymous = await request(env, `/api/pages/${page.id}/comments`)
    expect(anonymous.status).toBe(401)

    // 页面进回收站 → 评论接口随页面不可达。
    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    const hidden = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      viewer
    )
    expect(hidden.status).toBe(404)
  })

  it("空正文与超长正文被拒", async () => {
    const { env, author, page } = await scenario()

    const blank = await postComment(env, author, page.id, { bodyMd: "   " })
    expect(blank.status).toBe(400)
    expect(((await blank.json()) as { code: string }).code).toBe(
      "COMMENT_EMPTY"
    )

    const missing = await postComment(env, author, page.id, {})
    expect(missing.status).toBe(400)

    const huge = await postComment(env, author, page.id, {
      bodyMd: "字".repeat(20_001)
    })
    expect(huge.status).toBe(413)
  })
})

describe("评论：串结构、归一与软删呈现", () => {
  it("对回复再回复仍平铺在顶层之下，计数与可见条数一致", async () => {
    const { env, author, other, viewer, page } = await scenario()

    const first = await createComment(env, author, page.id, "顶层一")
    const second = await createComment(env, author, page.id, "顶层二")
    const reply = await createComment(env, other, page.id, "回复一", first.id)
    // 对「回复」再回复：parentId 仍是 first，不产生二级嵌套。
    const nested = await createComment(
      env,
      viewer,
      page.id,
      "回复的回复",
      reply.id
    )
    expect(nested.parentId).toBe(first.id)

    const body = await listComments(env, viewer, page.id)
    expect(body.total).toBe(4)
    expect(body.threads.map((thread) => thread.id)).toEqual([
      first.id,
      second.id
    ])
    expect(body.threads[0].replies?.map((item) => item.id)).toEqual([
      reply.id,
      nested.id
    ])
    expect(
      body.threads[0].replies?.every((item) => item.parentId === first.id)
    ).toBe(true)
  })

  it("删无回复的评论整条消失；删有回复的顶层保留占位且回复还在", async () => {
    const { env, author, other, page } = await scenario()

    const withReply = await createComment(env, author, page.id, "有回复的顶层")
    const lonely = await createComment(env, author, page.id, "没人理的顶层")
    const reply = await createComment(env, other, page.id, "回复", withReply.id)

    const delLonely = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${lonely.id}`,
      undefined,
      author
    )
    expect(delLonely.status).toBe(200)

    let body = await listComments(env, other, page.id)
    expect(body.threads.map((thread) => thread.id)).toEqual([withReply.id])
    expect(body.total).toBe(2)

    const delTop = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${withReply.id}`,
      undefined,
      author
    )
    expect(delTop.status).toBe(200)

    body = await listComments(env, other, page.id)
    expect(body.threads).toHaveLength(1)
    const placeholder = body.threads[0]
    expect(placeholder.id).toBe(withReply.id)
    expect(placeholder.deletedAt).not.toBeNull()
    expect(placeholder.bodyMd).toBe("")
    expect(placeholder.html).toBe("")
    expect(placeholder.canEdit).toBe(false)
    expect(placeholder.canDelete).toBe(false)
    expect(placeholder.replies?.map((item) => item.id)).toEqual([reply.id])
    // 占位不算进条数：只剩那条未删除的回复。
    expect(body.total).toBe(1)

    // 删回复 → 顶层再无存活回复，占位与回复一起消失。
    const delReply = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${reply.id}`,
      undefined,
      other
    )
    expect(delReply.status).toBe(200)
    body = await listComments(env, other, page.id)
    expect(body).toEqual({ total: 0, threads: [] })
  })

  it("已软删的顶层/回复仍接得住回复（挂回同一串）；父评论不属于本页按不存在处理", async () => {
    const { env, author, other, space, page } = await scenario()

    const top = await createComment(env, author, page.id, "顶层")
    const firstReply = await createComment(
      env,
      author,
      page.id,
      "原回复",
      top.id
    )
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${top.id}`,
      undefined,
      author
    )

    // 占位仍在（串下还有存活回复），前端「回复」提交的正是这个已软删的顶层 id。
    const afterDeleteTop = await createComment(
      env,
      other,
      page.id,
      "删后继续回",
      top.id
    )
    expect(afterDeleteTop.parentId).toBe(top.id)

    let body = await listComments(env, other, page.id)
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].id).toBe(top.id)
    expect(body.threads[0].deletedAt).not.toBeNull()
    expect(body.threads[0].replies?.map((item) => item.id)).toEqual([
      firstReply.id,
      afterDeleteTop.id
    ])
    expect(body.total).toBe(2)

    // 对着「一条已软删的回复」再回：归一后仍挂到同一顶层串（一级结构不破）。
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${firstReply.id}`,
      undefined,
      author
    )
    const toDeletedReply = await createComment(
      env,
      other,
      page.id,
      "对着已删回复再回",
      firstReply.id
    )
    expect(toDeletedReply.parentId).toBe(top.id)
    body = await listComments(env, other, page.id)
    expect(body.threads[0].replies?.map((item) => item.id)).toEqual([
      afterDeleteTop.id,
      toDeletedReply.id
    ])
    expect(body.total).toBe(2)

    // 拿另一页的评论 id 当 parentId：本页查不到 → 404（不泄露别的页面有它）。
    const otherPage = await createPage(env, author, "另一页", space.id)
    const foreign = await createComment(
      env,
      author,
      otherPage.id,
      "别的页面的评论"
    )
    const crossed = await postComment(env, other, page.id, {
      bodyMd: "回复",
      parentId: foreign.id
    })
    expect(crossed.status).toBe(404)
    expect(((await crossed.json()) as { code: string }).code).toBe(
      "COMMENT_NOT_FOUND"
    )
  })
})

describe("评论：编辑", () => {
  it("只有作者能改；改后 editedAt 非空、原文回填与 HTML 同步更新", async () => {
    const { env, author, other, page } = await scenario()

    const created = await createComment(env, author, page.id, "初版正文")
    expect(created.editedAt).toBeNull()

    const byOther = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      { bodyMd: "别人改" },
      other
    )
    expect(byOther.status).toBe(403)

    const edited = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      { bodyMd: "## 改过的正文" },
      author
    )
    expect(edited.status).toBe(200)
    const dto = (await edited.json()) as CommentDto
    expect(dto.bodyMd).toBe("## 改过的正文")
    expect(dto.html).toContain("<h2>改过的正文</h2>")
    expect(dto.editedAt).not.toBeNull()
    expect(dto.createdAt).toBe(created.createdAt)

    const body = await listComments(env, author, page.id)
    expect(body.threads[0].bodyMd).toBe("## 改过的正文")

    // 删掉之后不能再编辑。
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${created.id}`,
      undefined,
      author
    )
    const afterDelete = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      { bodyMd: "还能改吗" },
      author
    )
    expect(afterDelete.status).toBe(409)
  })
})

describe("评论：删除权限", () => {
  it("作者本人、空间 admin、站点管理员都能删；其余成员不能删别人的", async () => {
    const { env, author, other, viewer, spaceAdmin, admin, page } =
      await scenario()

    const own = await createComment(env, author, page.id, "作者自己的")
    const ownDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${own.id}`,
      undefined,
      author
    )
    expect(ownDelete.status).toBe(200)
    // 幂等：再删一次仍成功。
    const again = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${own.id}`,
      undefined,
      author
    )
    expect(again.status).toBe(200)

    const forSpaceAdmin = await createComment(
      env,
      author,
      page.id,
      "给空间管理员"
    )
    const spaceAdminDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${forSpaceAdmin.id}`,
      undefined,
      spaceAdmin
    )
    expect(spaceAdminDelete.status).toBe(200)

    const forSiteAdmin = await createComment(
      env,
      author,
      page.id,
      "给站点管理员"
    )
    const siteAdminDelete = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${forSiteAdmin.id}`,
      undefined,
      admin
    )
    expect(siteAdminDelete.status).toBe(200)

    const forOthers = await createComment(env, author, page.id, "别人想删")
    // space editor 与 viewer 都不是作者、也不是空间 admin：403。
    for (const cookie of [other, viewer]) {
      const denied = await jsonRequest(
        env,
        "DELETE",
        `/api/pages/${page.id}/comments/${forOthers.id}`,
        undefined,
        cookie
      )
      expect(denied.status).toBe(403)
    }
    expect((await listComments(env, author, page.id)).total).toBe(1)
  })
})

describe("评论：Markdown 与预览", () => {
  it("列表与预览走同一条渲染净化链，预览不写库", async () => {
    const { env, author, page } = await scenario()
    const bodyMd = [
      "## 小节",
      "",
      "- 一",
      "- 二",
      "",
      "> 引用",
      "",
      "```js",
      "const a = 1",
      "```"
    ].join("\n")

    const preview = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments/preview`,
      { bodyMd },
      author
    )
    expect(preview.status).toBe(200)
    const { html } = (await preview.json()) as { html: string }
    expect(html).toContain("<h2>小节</h2>")
    expect(html).toContain("<blockquote>")
    expect(html).toContain('class="language-js"')

    // 预览不落库。
    expect(await listComments(env, author, page.id)).toEqual({
      total: 0,
      threads: []
    })

    const created = await createComment(env, author, page.id, bodyMd)
    expect(created.html).toBe(html)
    const listed = await listComments(env, author, page.id)
    expect(listed.threads[0].html).toBe(html)

    // 预览同样要求读权限。
    const anonymous = await request(
      env,
      `/api/pages/${page.id}/comments/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyMd })
      }
    )
    expect(anonymous.status).toBe(401)
  })
})

describe("评论：与页面的联动", () => {
  it("回滚旧版本后评论不变", async () => {
    const { env, admin, author, page } = await scenario()
    const before = await createComment(env, author, page.id, "回滚前的评论")

    await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}`,
      {
        title: "评论页",
        contentJson: JSON.stringify({ type: "doc" }),
        contentHtml: "<p>第二版</p>",
        contentText: "第二版"
      },
      admin
    )
    const revisions = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/pages/${page.id}/revisions`,
        undefined,
        admin
      )
    ).json()) as Array<{ id: string }>
    // 列表是最新在前：最后一条是最初的版本。
    const oldest = revisions[revisions.length - 1]
    const restored = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/revisions/${oldest.versionNo}/restore`,
      undefined,
      admin
    )
    expect(restored.status).toBe(200)

    const after = await listComments(env, author, page.id)
    expect(after.total).toBe(1)
    expect(after.threads[0].id).toBe(before.id)
    expect(after.threads[0].html).toBe(before.html)
  })

  it("页面进回收站评论不可达，恢复后原样回来；彻底删除后评论行随父页消失", async () => {
    const { env, db, admin, author, other, page } = await scenario()
    const top = await createComment(env, author, page.id, "会被回收的顶层")
    const reply = await createComment(env, other, page.id, "回复", top.id)

    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    const hidden = await jsonRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      undefined,
      author
    )
    expect(hidden.status).toBe(404)

    await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/restore`,
      undefined,
      admin
    )
    const restored = await listComments(env, author, page.id)
    expect(restored.total).toBe(2)
    expect(restored.threads[0].id).toBe(top.id)
    expect(restored.threads[0].replies?.map((item) => item.id)).toEqual([
      reply.id
    ])

    // 彻底删除：页面与评论一起硬删。
    await jsonRequest(env, "DELETE", `/api/pages/${page.id}`, undefined, admin)
    const permanent = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/permanent`,
      undefined,
      admin
    )
    expect(permanent.status).toBe(200)
    const left = db.db
      .prepare("SELECT COUNT(*) AS count FROM ciki_comments WHERE page_id = ?")
      .get(page.id) as { count: number }
    expect(left.count).toBe(0)
  })
})
