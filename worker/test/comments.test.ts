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

describe("Agent 令牌评论写端点鉴权与行为", () => {
  async function createAgentAndToken(
    env: Env,
    ownerCookie: string,
    username = "bot-commenter",
    kind: "read" | "write" = "write"
  ): Promise<{
    agentId: number
    token: string
    tokenId: number
    username: string
  }> {
    const createRes = await jsonRequest(
      env,
      "POST",
      "/api/me/agents",
      { username },
      ownerCookie
    )
    expect(createRes.status).toBe(201)
    const agent = (await createRes.json()) as { id: number; username: string }

    const tokenRes = await jsonRequest(
      env,
      "POST",
      `/api/me/agents/${agent.id}/tokens`,
      { kind },
      ownerCookie
    )
    expect(tokenRes.status).toBe(201)
    const tokenData = (await tokenRes.json()) as { id: number; token: string }

    return {
      agentId: agent.id,
      token: tokenData.token,
      tokenId: tokenData.id,
      username: agent.username
    }
  }

  async function addAgentToSpace(
    env: Env,
    adminCookie: string,
    spaceId: string,
    agentId: number,
    role: "admin" | "editor" | "viewer" = "editor"
  ): Promise<void> {
    const res = await jsonRequest(
      env,
      "POST",
      `/api/spaces/${spaceId}/members`,
      { userId: agentId, role },
      adminCookie
    )
    expect(res.status).toBe(201)
  }

  function tokenRequest(
    env: Env,
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    return request(env, path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  it("发表（POST /:id/comments）：持 write 令牌的 Agent 正常发表顶层与回复（一级串归一），viewer 角色亦可发表", async () => {
    const { env, admin, author, space, page } = await scenario()
    const agent = await createAgentAndToken(env, author, "agent-poster")
    await addAgentToSpace(env, admin, space.id, agent.agentId, "editor")

    // 1. 发表顶层评论
    const postRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "## Agent 顶层评论\n来自 agent 的正文" }
    )
    expect(postRes.status).toBe(201)
    const created = (await postRes.json()) as CommentDto & {
      isAgent: boolean
      ownerName: string | null
    }
    expect(created.bodyMd).toBe("## Agent 顶层评论\n来自 agent 的正文")
    expect(created.html).toContain("<h2>Agent 顶层评论</h2>")
    expect(created.authorId).toBe(agent.agentId)
    expect(created.authorName).toBe("agent-poster")
    expect(created.isAgent).toBe(true)
    expect(created.ownerName).toBeTruthy()
    expect(created.canEdit).toBe(true)
    expect(created.canDelete).toBe(true)

    // 2. 回复该评论
    const replyRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "Agent 一级回复", parentId: created.id }
    )
    expect(replyRes.status).toBe(201)
    const reply = (await replyRes.json()) as CommentDto
    expect(reply.parentId).toBe(created.id)

    // 3. 对回复再回复：一级串归一，parentId 仍为顶层 id
    const subReplyRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "Agent 二级回复归一", parentId: reply.id }
    )
    expect(subReplyRes.status).toBe(201)
    const subReply = (await subReplyRes.json()) as CommentDto
    expect(subReply.parentId).toBe(created.id)

    // 4. viewer 角色的 Agent 亦可发表（权限尺与真人同一把尺，不加 editor 门槛）
    const viewerAgent = await createAgentAndToken(env, author, "agent-viewer")
    await addAgentToSpace(env, admin, space.id, viewerAgent.agentId, "viewer")
    const viewerPostRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      viewerAgent.token,
      { bodyMd: "Viewer agent 也可发表" }
    )
    expect(viewerPostRes.status).toBe(201)
  })

  it("预览（POST /:id/comments/preview）：持 write 令牌的 Agent 正常渲染与空正文处理", async () => {
    const { env, admin, author, space, page } = await scenario()
    const agent = await createAgentAndToken(env, author, "agent-previewer")
    await addAgentToSpace(env, admin, space.id, agent.agentId, "editor")

    const prevRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments/preview`,
      agent.token,
      { bodyMd: "**粗体正文**" }
    )
    expect(prevRes.status).toBe(200)
    const prevData = (await prevRes.json()) as { html: string }
    expect(prevData.html).toContain("<strong>粗体正文</strong>")

    // 空正文返回 200 {"html":""}
    const emptyRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments/preview`,
      agent.token,
      { bodyMd: "" }
    )
    expect(emptyRes.status).toBe(200)
    expect((await emptyRes.json()) as { html: string }).toEqual({ html: "" })
  })

  it("编辑（PUT /:id/comments/:commentId）：Agent 可编辑自己评论，他人编辑报 403", async () => {
    const { env, admin, author, other, space, page } = await scenario()
    const agent = await createAgentAndToken(env, author, "agent-editor")
    await addAgentToSpace(env, admin, space.id, agent.agentId, "editor")

    const postRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "初版正文" }
    )
    const created = (await postRes.json()) as CommentDto

    // 1. Agent 编辑自己发表的评论
    const editRes = await tokenRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      agent.token,
      { bodyMd: "修改后的正文" }
    )
    expect(editRes.status).toBe(200)
    const edited = (await editRes.json()) as CommentDto
    expect(edited.bodyMd).toBe("修改后的正文")
    expect(edited.editedAt).not.toBeNull()

    // 2. 他人（真人或其他 Agent）尝试编辑该评论：403
    const forbiddenHuman = await jsonRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      { bodyMd: "真人试图修改" },
      other
    )
    expect(forbiddenHuman.status).toBe(403)

    const otherAgent = await createAgentAndToken(env, author, "other-agent")
    await addAgentToSpace(env, admin, space.id, otherAgent.agentId, "editor")
    const forbiddenAgent = await tokenRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${created.id}`,
      otherAgent.token,
      { bodyMd: "别的 agent 试图修改" }
    )
    expect(forbiddenAgent.status).toBe(403)

    // 3. Agent 尝试编辑真人的评论：403
    const humanComment = await createComment(env, author, page.id, "真人的评论")
    const editHumanComment = await tokenRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/${humanComment.id}`,
      agent.token,
      { bodyMd: "Agent 试图修改真人的评论" }
    )
    expect(editHumanComment.status).toBe(403)
  })

  it("删除（DELETE /:id/comments/:commentId）：Agent 可删自己评论，空间管理员可删 Agent 评论，非作者 403", async () => {
    const { env, admin, author, other, spaceAdmin, space, page } =
      await scenario()
    const agent = await createAgentAndToken(env, author, "agent-deleter")
    await addAgentToSpace(env, admin, space.id, agent.agentId, "editor")

    const postRes1 = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "Agent 评论 1" }
    )
    const comment1 = (await postRes1.json()) as CommentDto

    const postRes2 = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "Agent 评论 2" }
    )
    const comment2 = (await postRes2.json()) as CommentDto

    // 1. 非作者普通成员（other）尝试删除 Agent 评论：403
    const denyOther = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${comment1.id}`,
      undefined,
      other
    )
    expect(denyOther.status).toBe(403)

    // 2. Agent 删除自己的评论：200 且幂等
    const delRes1 = await tokenRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${comment1.id}`,
      agent.token
    )
    expect(delRes1.status).toBe(200)
    expect((await delRes1.json()) as { success: boolean }).toEqual({
      success: true
    })

    const delAgain = await tokenRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${comment1.id}`,
      agent.token
    )
    expect(delAgain.status).toBe(200)

    // 3. 空间管理员（spaceAdmin）删除 Agent 评论：200
    const delAdmin = await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${comment2.id}`,
      undefined,
      spaceAdmin
    )
    expect(delAdmin.status).toBe(200)

    // 4. Agent（普通 editor）尝试删除他人的评论：403
    const humanComment = await createComment(env, author, page.id, "真人的评论")
    const denyAgentDelHuman = await tokenRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${humanComment.id}`,
      agent.token
    )
    expect(denyAgentDelHuman.status).toBe(403)
  })

  it("空间成员与存在性隔离：未加入空间的 Agent 返回 404，不泄露页面存在性", async () => {
    const { env, author, page } = await scenario()
    const outsider = await createAgentAndToken(env, author, "outsider-agent")
    // 注意：outsider 未加入 space

    const postRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      outsider.token,
      { bodyMd: "未加入空间" }
    )
    expect(postRes.status).toBe(404)
    expect((await postRes.json()) as { error: string }).toEqual({
      error: "Page not found"
    })

    const prevRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments/preview`,
      outsider.token,
      { bodyMd: "未加入空间" }
    )
    expect(prevRes.status).toBe(404)

    const editRes = await tokenRequest(
      env,
      "PUT",
      `/api/pages/${page.id}/comments/1`,
      outsider.token,
      { bodyMd: "未加入空间" }
    )
    expect(editRes.status).toBe(404)

    const delRes = await tokenRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/1`,
      outsider.token
    )
    expect(delRes.status).toBe(404)

    // 不存在的页面也是 404
    const notFoundPage = await tokenRequest(
      env,
      "POST",
      "/api/pages/999999/comments",
      outsider.token,
      { bodyMd: "不存在的页面" }
    )
    expect(notFoundPage.status).toBe(404)
  })

  it("令牌类型与失效语义：read 令牌/无效令牌/已吊销/停用均 401，头冲突不回落", async () => {
    const { env, admin, author, space, page } = await scenario()

    // 1. read 类型令牌被拒：401
    const readAgent = await createAgentAndToken(
      env,
      author,
      "read-agent",
      "read"
    )
    await addAgentToSpace(env, admin, space.id, readAgent.agentId, "editor")
    const readPost = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      readAgent.token,
      { bodyMd: "read 令牌不可写评论" }
    )
    expect(readPost.status).toBe(401)
    expect(readPost.headers.get("cache-control")).toBe("no-store")

    // 2. 无效/不存在的令牌：401
    const badTokenPost = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      "invalid-token-string",
      { bodyMd: "无效令牌" }
    )
    expect(badTokenPost.status).toBe(401)

    // 3. 吊销后的令牌：401
    const writeAgent = await createAgentAndToken(env, author, "agent-revoking")
    await addAgentToSpace(env, admin, space.id, writeAgent.agentId, "editor")
    const revokeRes = await jsonRequest(
      env,
      "DELETE",
      `/api/me/agents/${writeAgent.agentId}/tokens/${writeAgent.tokenId}`,
      undefined,
      author
    )
    expect(revokeRes.status).toBe(200)
    const revokedPost = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      writeAgent.token,
      { bodyMd: "吊销后" }
    )
    expect(revokedPost.status).toBe(401)

    // 4. Agent 账号被停用（isActive=false）：401
    const doomedAgent = await createAgentAndToken(env, author, "agent-doomed")
    await addAgentToSpace(env, admin, space.id, doomedAgent.agentId, "editor")
    const patchRes = await jsonRequest(
      env,
      "PATCH",
      `/api/me/agents/${doomedAgent.agentId}`,
      { isActive: false },
      author
    )
    expect(patchRes.status).toBe(200)
    const inactivePost = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      doomedAgent.token,
      { bodyMd: "停用后" }
    )
    expect(inactivePost.status).toBe(401)

    // 5. 头信息冲突：同时携带无效 Authorization 头与有效 Session Cookie 时直接 401，不回落会话
    const conflictRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      "bad-bearer-token",
      { bodyMd: "冲突测试" },
      { cookie: author }
    )
    expect(conflictRes.status).toBe(401)
    expect(conflictRes.headers.get("cache-control")).toBe("no-store")

    // 6. 畸形 Authorization 头（如 Basic 或空 Bearer）：401
    const malformedRes = await request(env, `/api/pages/${page.id}/comments`, {
      method: "POST",
      headers: {
        authorization: "Basic dXNlcjpwYXNz",
        "content-type": "application/json"
      },
      body: JSON.stringify({ bodyMd: "畸形头" })
    })
    expect(malformedRes.status).toBe(401)
  })

  it("隔离性：GET 评论列表与页面路由对 Agent 令牌严格拦截 401，真人查列表正确呈现 Agent 评论", async () => {
    const { env, admin, author, space, page } = await scenario()
    const agent = await createAgentAndToken(env, author, "agent-isolation")
    await addAgentToSpace(env, admin, space.id, agent.agentId, "editor")

    // 1. Agent 发表一条评论
    const postRes = await tokenRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      agent.token,
      { bodyMd: "Agent 隔离测试评论" }
    )
    expect(postRes.status).toBe(201)

    // 2. Agent 持 write 令牌调 GET /api/pages/:id/comments（列表）：401 隔离
    const listByToken = await tokenRequest(
      env,
      "GET",
      `/api/pages/${page.id}/comments`,
      agent.token
    )
    expect(listByToken.status).toBe(401)

    // 3. Agent 持 write 令牌调页面会话端点 GET /api/pages/:id 与 POST /api/pages：401 隔离
    const pageGetByToken = await tokenRequest(
      env,
      "GET",
      `/api/pages/${page.id}`,
      agent.token
    )
    expect(pageGetByToken.status).toBe(401)

    const pagePostByToken = await tokenRequest(
      env,
      "POST",
      "/api/pages",
      agent.token,
      { title: "跨界写页", spaceId: space.id }
    )
    expect(pagePostByToken.status).toBe(401)

    // 4. 真人通过会话 GET 查列表：正常展示，isAgent 为 true，ownerName 与 authorName 正确
    const listByHuman = await listComments(env, author, page.id)
    expect(listByHuman.total).toBe(1)
    const comment = listByHuman.threads[0] as unknown as {
      isAgent: boolean
      authorName: string
      ownerName: string | null
      bodyMd: string
    }
    expect(comment.isAgent).toBe(true)
    expect(comment.authorName).toBe("agent-isolation")
    expect(comment.ownerName).toBeTruthy()
    expect(comment.bodyMd).toBe("Agent 隔离测试评论")
  })
})
