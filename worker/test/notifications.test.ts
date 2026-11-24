import { describe, expect, it } from "vitest"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import { issueApiToken } from "../src/core/api-token"
import { createAgentUser } from "../src/db/queries/users"
import { notificationsTable, usersTable } from "../src/lib/tables"
import type { NotificationDto } from "../src/routes/notifications"

type Env = Parameters<typeof adminSession>[0]

async function meId(env: Env, cookie: string): Promise<number> {
  const me = (await (
    await jsonRequest(env, "GET", "/api/me", undefined, cookie)
  ).json()) as { id: number }
  return me.id
}

async function createSpace(
  env: Env,
  cookie: string,
  name: string
): Promise<{ id: number }> {
  const res = await jsonRequest(env, "POST", "/api/spaces", { name }, cookie)
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

async function addMember(
  env: Env,
  admin: string,
  spaceId: number,
  cookie: string,
  role: "admin" | "editor" | "viewer"
): Promise<void> {
  const userId = await meId(env, cookie)
  const res = await jsonRequest(
    env,
    "POST",
    `/api/spaces/${spaceId}/members`,
    { userId, role },
    admin
  )
  expect(res.status).toBe(201)
}

async function createPage(
  env: Env,
  cookie: string,
  title: string,
  spaceId: number
): Promise<{ id: number }> {
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
  return (await res.json()) as { id: number }
}

async function postComment(
  env: Env,
  cookie: string,
  pageId: number,
  bodyMd: string,
  parentId?: number | null
): Promise<{ id: number }> {
  const res = await jsonRequest(
    env,
    "POST",
    `/api/pages/${pageId}/comments`,
    { bodyMd, parentId: parentId ?? null },
    cookie
  )
  expect(res.status).toBe(201)
  return (await res.json()) as { id: number }
}

describe("评论通知（notifications 迁移 + 同步产生 + 通知接口）", () => {
  it("schema_v11 迁移：notifications 表与索引正确创建", async () => {
    const { db } = await initializedContext()
    const rawColumns = db.db
      .prepare("PRAGMA table_info(ciki_notifications)")
      .all() as Array<{ name: string; type: string; notnull: number }>
    const cols = Object.fromEntries(rawColumns.map((c) => [c.name, c]))

    expect(cols.id).toBeDefined()
    expect(cols.recipient_id).toBeDefined()
    expect(cols.recipient_id.notnull).toBe(1)
    expect(cols.actor_id).toBeDefined()
    expect(cols.type).toBeDefined()
    expect(cols.page_id).toBeDefined()
    expect(cols.comment_id).toBeDefined()
    expect(cols.page_title).toBeDefined()
    expect(cols.excerpt).toBeDefined()
    expect(cols.created_at).toBeDefined()
    expect(cols.read_at).toBeDefined()
    expect(cols.read_at.notnull).toBe(0)

    const rawIndexes = db.db
      .prepare("PRAGMA index_list(ciki_notifications)")
      .all() as Array<{ name: string }>
    const indexNames = new Set(rawIndexes.map((i) => i.name))
    expect(indexNames.has("ciki_notifications_recipient_read")).toBe(true)
    expect(indexNames.has("ciki_notifications_recipient_created")).toBe(true)
  })

  it("Jim 场景：B 评论 A 的文档 → A 角标 +1，标已读后角标清零", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-a@example.com")
    const userB = await userSession(env, admin, "user-b@example.com")

    const space = await createSpace(env, admin, "通知测试空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "A 的文档", space.id)

    // 评论前 A 与 B 未读数均为 0
    const beforeCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(beforeCountA.count).toBe(0)
    expect(beforeCountA.unreadCount).toBe(0)

    // B 在 A 的文档下评论
    const comment = await postComment(env, userB, page.id, "B 发表的顶层评论")

    // A 未读数变为 1
    const afterCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(afterCountA.count).toBe(1)
    expect(afterCountA.unreadCount).toBe(1)

    // B 未读数仍为 0（评论者本人不收）
    const afterCountB = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userB
      )
    ).json()) as { count: number; unreadCount: number }
    expect(afterCountB.count).toBe(0)

    // A 查询通知列表
    const listRes = await jsonRequest(
      env,
      "GET",
      "/api/notifications",
      undefined,
      userA
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as NotificationDto[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      type: "comment",
      pageId: page.id,
      commentId: comment.id,
      pageTitle: "A 的文档",
      excerpt: "B 发表的顶层评论",
      read: false,
      isRead: false,
      readAt: null
    })

    // A 标已读
    const readRes = await jsonRequest(
      env,
      "POST",
      `/api/notifications/${list[0].id}/read`,
      undefined,
      userA
    )
    expect(readRes.status).toBe(200)
    expect(await readRes.json()).toEqual({ success: true })

    // A 未读数清零
    const finalCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(finalCountA.count).toBe(0)
    expect(finalCountA.unreadCount).toBe(0)

    // 列表中已读状态已更新
    const listAfterRead = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listAfterRead[0].read).toBe(true)
    expect(listAfterRead[0].isRead).toBe(true)
    expect(listAfterRead[0].readAt).not.toBeNull()
  })

  it("Jim 场景：C 回复 B 的评论 → B 收到 reply 型通知，A（文档作者）收到 comment 型通知", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-a2@example.com")
    const userB = await userSession(env, admin, "user-b2@example.com")
    const userC = await userSession(env, admin, "user-c2@example.com")

    const space = await createSpace(env, admin, "多方回复空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")
    await addMember(env, admin, space.id, userC, "editor")

    const page = await createPage(env, userA, "协作文档", space.id)
    const topComment = await postComment(env, userB, page.id, "B 的顶层评论")

    // 清空 A 首次收到的评论通知以便观察回复
    await jsonRequest(
      env,
      "POST",
      "/api/notifications/read-all",
      undefined,
      userA
    )

    // C 回复 B 的评论
    const replyComment = await postComment(
      env,
      userC,
      page.id,
      "C 回复 B 的评论内容",
      topComment.id
    )

    // B 收到 reply 型通知
    const listB = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userB)
    ).json()) as NotificationDto[]
    expect(listB).toHaveLength(1)
    expect(listB[0]).toMatchObject({
      type: "reply",
      pageId: page.id,
      commentId: replyComment.id,
      pageTitle: "协作文档",
      excerpt: "C 回复 B 的评论内容",
      read: false
    })

    // A 收到 comment 型通知
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    // A 此前有 1 条已读，新来 1 条未读
    expect(listA).toHaveLength(2)
    expect(listA[0]).toMatchObject({
      type: "comment",
      pageId: page.id,
      commentId: replyComment.id,
      pageTitle: "协作文档",
      read: false
    })

    // C 本人收到 0 条
    const countC = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userC
      )
    ).json()) as { count: number }
    expect(countC.count).toBe(0)
  })

  it("A 评论自己的文档不产生通知", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-self@example.com")

    const space = await createSpace(env, admin, "自评空间")
    await addMember(env, admin, space.id, userA, "editor")
    const page = await createPage(env, userA, "自己写的文档", space.id)

    await postComment(env, userA, page.id, "自己评论自己的文档")

    const countA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number }
    expect(countA.count).toBe(0)

    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA).toHaveLength(0)
  })

  it("去重与优先级口径：A 在自己的文档发表评论，B 回复 A → A 仅收 1 条且 type 为 reply", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-owner-author@example.com")
    const userB = await userSession(env, admin, "user-replier@example.com")

    const space = await createSpace(env, admin, "去重空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "双重身份文档", space.id)
    const topComment = await postComment(
      env,
      userA,
      page.id,
      "A 自己的顶层评论"
    )

    // B 回复 A 的顶层评论
    const reply = await postComment(
      env,
      userB,
      page.id,
      "B 回复 A 在 A 文档下的评论",
      topComment.id
    )

    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    // 同一人只写一条，其为父评论作者时 type 取 reply
    expect(listA).toHaveLength(1)
    expect(listA[0]).toMatchObject({
      type: "reply",
      pageId: page.id,
      commentId: reply.id
    })
  })

  it("Agent 持 write 令牌评论 → 文档作者正常收到通知", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-human@example.com")
    const adminUserId = await meId(env, admin)

    const space = await createSpace(env, admin, "Agent 评论空间")
    await addMember(env, admin, space.id, userA, "editor")

    const page = await createPage(env, userA, "人类写的文档", space.id)

    // 创建 Agent 账号并分配空间权限与 write 令牌
    const agentId = await createAgentUser(env.DB, prefix, {
      username: "bot-commenter",
      owner_user_id: adminUserId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-write-token"
    })

    // Agent 持令牌调用评论端点
    const commentRes = await request(env, `/api/pages/${page.id}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ bodyMd: "Agent 发出的专业评论" })
    })
    expect(commentRes.status).toBe(201)
    const commentBody = (await commentRes.json()) as { id: number }

    // 人类接收人 A 收到通知，actorId 为 Agent 用户 id
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA).toHaveLength(1)
    expect(listA[0]).toMatchObject({
      type: "comment",
      actorId: agentId,
      actorName: "bot-commenter",
      commentId: commentBody.id,
      pageTitle: "人类写的文档",
      excerpt: "Agent 发出的专业评论"
    })
  })

  it("Agent 账号永不作为接收人：人类回复 Agent 评论时，Agent 不产生通知", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-doc-author@example.com")
    const userB = await userSession(env, admin, "user-replier2@example.com")
    const adminUserId = await meId(env, admin)

    const space = await createSpace(env, admin, "Agent 排除空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "包含 Agent 评论的文档", space.id)

    const agentId = await createAgentUser(env.DB, prefix, {
      username: "silent-bot",
      owner_user_id: adminUserId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-write-token"
    })

    // Agent 发表顶层评论
    const agentCommentRes = await request(
      env,
      `/api/pages/${page.id}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ bodyMd: "Agent 的顶层评论" })
      }
    )
    expect(agentCommentRes.status).toBe(201)
    const agentComment = (await agentCommentRes.json()) as { id: number }

    // 清理 A 收到的一条通知
    await jsonRequest(
      env,
      "POST",
      "/api/notifications/read-all",
      undefined,
      userA
    )

    // 用户 B 回复 Agent 的评论
    await postComment(
      env,
      userB,
      page.id,
      "B 回复 Agent 的评论",
      agentComment.id
    )

    // 数据库直接检查 Agent 名下是否有任何通知
    const agentNotifications = await env.DB.prepare(
      `SELECT * FROM ${notificationsTable(prefix)} WHERE recipient_id = ?`
    )
      .bind(agentId)
      .all()
    expect(agentNotifications.results).toHaveLength(0)

    // 人类文档作者 A 仍然收到针对该文档的新评论通知
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA.filter((n) => !n.read)).toHaveLength(1)
  })

  it("Agent 写的文档，人类发顶层评论 → 归属人角标 +1，点开跳转定位到该评论、角标清零", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(
      env,
      admin,
      "user-owner-agent-doc@example.com"
    )
    const userB = await userSession(
      env,
      admin,
      "user-commenter-agent-doc@example.com"
    )
    const userAId = await meId(env, userA)
    const userBId = await meId(env, userB)

    const space = await createSpace(env, admin, "Agent 文档归属人空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    // 创建归属于 User A 的 Agent 账号并分配空间编辑者权限与 write 令牌
    const agentId = await createAgentUser(env.DB, prefix, {
      username: "agent-writer",
      owner_user_id: userAId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-doc-token"
    })

    // Agent 创建文档
    const pageRes = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Agent 创作的技术文档",
        space_id: space.id,
        content_json: JSON.stringify({ type: "doc" })
      })
    })
    expect(pageRes.status).toBe(201)
    const page = (await pageRes.json()) as { id: number }

    // 评论前 A 与 B 未读数均为 0
    const beforeCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(beforeCountA.unreadCount).toBe(0)

    // 人类 B 在 Agent 写的文档下发表顶层评论
    const comment = await postComment(
      env,
      userB,
      page.id,
      "人类对 Agent 文档的顶层评论"
    )

    // 归属人 A 未读数变为 1
    const afterCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(afterCountA.count).toBe(1)
    expect(afterCountA.unreadCount).toBe(1)

    // 归属人 A 查看通知列表：收到 comment 型通知，且快照与定位信息完整
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA).toHaveLength(1)
    expect(listA[0]).toMatchObject({
      type: "comment",
      actorId: userBId,
      commentId: comment.id,
      pageTitle: "Agent 创作的技术文档",
      excerpt: "人类对 Agent 文档的顶层评论",
      read: false
    })

    // Agent 账号自身永不产生任何通知
    const agentNotifications = await env.DB.prepare(
      `SELECT * FROM ${notificationsTable(prefix)} WHERE recipient_id = ?`
    )
      .bind(agentId)
      .all()
    expect(agentNotifications.results).toHaveLength(0)

    // 归属人 A 标单条已读，角标清零
    const readRes = await jsonRequest(
      env,
      "POST",
      `/api/notifications/${listA[0].id}/read`,
      undefined,
      userA
    )
    expect(readRes.status).toBe(200)

    const finalCountA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(finalCountA.unreadCount).toBe(0)
  })

  it("Agent 文档回复通知：不同人时归属人另收 comment 型一条，父评论作者收到 reply 型", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-owner-diff@example.com")
    const userB = await userSession(
      env,
      admin,
      "user-parent-author@example.com"
    )
    const userC = await userSession(env, admin, "user-replier-diff@example.com")
    const userAId = await meId(env, userA)
    const userCId = await meId(env, userC)

    const space = await createSpace(env, admin, "不同人回复测试空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")
    await addMember(env, admin, space.id, userC, "editor")

    const agentId = await createAgentUser(env.DB, prefix, {
      username: "agent-author-diff",
      owner_user_id: userAId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-token-diff"
    })

    const pageRes = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Agent 的跨人回复页",
        space_id: space.id,
        content_json: JSON.stringify({ type: "doc" })
      })
    })
    expect(pageRes.status).toBe(201)
    const page = (await pageRes.json()) as { id: number }

    // B 发表顶层评论
    const commentB = await postComment(env, userB, page.id, "B 发表的顶层评论")

    // 清空 A 此时收到的 1 条未读（顶层评论通知）
    await jsonRequest(
      env,
      "POST",
      "/api/notifications/read-all",
      undefined,
      userA
    )

    // C 回复 B 的评论
    const replyC = await postComment(
      env,
      userC,
      page.id,
      "C 回复 B",
      commentB.id
    )

    // 父评论作者 B 收到 reply 型通知
    const listB = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userB)
    ).json()) as NotificationDto[]
    expect(listB).toHaveLength(1)
    expect(listB[0]).toMatchObject({
      type: "reply",
      actorId: userCId,
      commentId: replyC.id
    })

    // 归属人 A 收到 comment 型通知一条
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    const unreadA = listA.filter((n) => !n.read)
    expect(unreadA).toHaveLength(1)
    expect(unreadA[0]).toMatchObject({
      type: "comment",
      actorId: userCId,
      commentId: replyC.id
    })
  })

  it("Agent 文档回复通知：归属人与父评论作者为同一人时只收 1 条且 type 为 reply", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-owner-same@example.com")
    const userB = await userSession(env, admin, "user-replier-same@example.com")
    const userAId = await meId(env, userA)
    const userBId = await meId(env, userB)

    const space = await createSpace(env, admin, "同一人回复测试空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const agentId = await createAgentUser(env.DB, prefix, {
      username: "agent-author-same",
      owner_user_id: userAId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-token-same"
    })

    const pageRes = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Agent 的同作者回复页",
        space_id: space.id,
        content_json: JSON.stringify({ type: "doc" })
      })
    })
    expect(pageRes.status).toBe(201)
    const page = (await pageRes.json()) as { id: number }

    // 归属人 A 在自己 Agent 的文档下发表评论（不通知自己）
    const commentA = await postComment(env, userA, page.id, "归属人 A 的评论")
    const countAAfterOwnComment = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(countAAfterOwnComment.unreadCount).toBe(0)

    // B 回复 A 的评论
    const replyB = await postComment(
      env,
      userB,
      page.id,
      "B 回复 A",
      commentA.id
    )

    // A 仅收到 1 条通知，且 type 为 reply
    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA).toHaveLength(1)
    expect(listA[0]).toMatchObject({
      type: "reply",
      actorId: userBId,
      commentId: replyB.id
    })
  })

  it("归属人评论自己 Agent 的文档 → 不产生通知", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-owner-self@example.com")
    const userAId = await meId(env, userA)

    const space = await createSpace(env, admin, "归属人自己评论空间")
    await addMember(env, admin, space.id, userA, "editor")

    const agentId = await createAgentUser(env.DB, prefix, {
      username: "agent-self-doc",
      owner_user_id: userAId
    })
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: agentId, role: "editor" },
      admin
    )
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "agent-token-self"
    })

    const pageRes = await request(env, "/api/write/pages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: "Agent 的归属人文档",
        space_id: space.id,
        content_json: JSON.stringify({ type: "doc" })
      })
    })
    expect(pageRes.status).toBe(201)
    const page = (await pageRes.json()) as { id: number }

    // 归属人 A 评论该文档
    await postComment(env, userA, page.id, "A 自己写的评论")

    const countA = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications/unread-count",
        undefined,
        userA
      )
    ).json()) as { count: number; unreadCount: number }
    expect(countA.count).toBe(0)
    expect(countA.unreadCount).toBe(0)

    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(listA).toHaveLength(0)
  })

  it("孤儿 Agent（owner_user_id 为 null）文档，人类发评论 → 保守维持现状：不替换、无接收人，不产生通知", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const userB = await userSession(
      env,
      admin,
      "user-commenter-orphan@example.com"
    )

    const space = await createSpace(env, admin, "孤儿 Agent 空间")
    await addMember(env, admin, space.id, userB, "editor")

    // 直接插入一个没有 owner_user_id 的孤儿 Agent
    const orphanAgentId = 98765
    await env.DB.prepare(
      `INSERT INTO ${usersTable(prefix)} (
        id, email, password_hash, username, avatar_key, role, is_active,
        approval_status, email_verified, language, kind, owner_user_id, created_at, updated_at
      ) VALUES (?, ?, 'hash', ?, '', 'user', 1, 'approved', 1, 'zh-CN', 'agent', NULL, datetime('now'), datetime('now'))`
    )
      .bind(orphanAgentId, "orphan-agent@example.com", "orphan-agent")
      .run()

    // 页面由孤儿 Agent 创建
    const page = await createPage(env, admin, "孤儿 Agent 文档", space.id)
    await env.DB.prepare(
      `UPDATE ${prefix}pages SET created_by = ? WHERE id = ?`
    )
      .bind(orphanAgentId, page.id)
      .run()

    // 人类 B 发表顶层评论
    const comment = await postComment(
      env,
      userB,
      page.id,
      "评论孤儿 Agent 文档"
    )

    // 检查通知表中没有任何针对此评论的通知记录
    const notifications = await env.DB.prepare(
      `SELECT * FROM ${notificationsTable(prefix)} WHERE comment_id = ?`
    )
      .bind(comment.id)
      .all()
    expect(notifications.results).toHaveLength(0)
  })

  it("标单条已读权限控制：仅限本人（他人 403，不存在 404）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-owner-notif@example.com")
    const userB = await userSession(env, admin, "user-intruder@example.com")

    const space = await createSpace(env, admin, "权限隔离空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "权限测试页", space.id)
    await postComment(env, userB, page.id, "一条给 A 的评论")

    const listA = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    const notifId = listA[0].id

    // B 尝试标 A 的通知已读 → 403 Forbidden
    const forbiddenRes = await jsonRequest(
      env,
      "POST",
      `/api/notifications/${notifId}/read`,
      undefined,
      userB
    )
    expect(forbiddenRes.status).toBe(403)
    expect(await forbiddenRes.json()).toEqual({ error: "Forbidden" })

    // 不存在的通知 id → 404
    const notFoundRes = await jsonRequest(
      env,
      "POST",
      "/api/notifications/999999/read",
      undefined,
      userA
    )
    expect(notFoundRes.status).toBe(404)

    // A 本人标记已读 → 200
    const successRes = await jsonRequest(
      env,
      "POST",
      `/api/notifications/${notifId}/read`,
      undefined,
      userA
    )
    expect(successRes.status).toBe(200)
    expect(await successRes.json()).toEqual({ success: true })

    // 重复标记已读幂等 → 200
    const secondRes = await jsonRequest(
      env,
      "POST",
      `/api/notifications/${notifId}/read`,
      undefined,
      userA
    )
    expect(secondRes.status).toBe(200)
  })

  it("全部标已读：将当前用户的所有未读标为已读，且不影响他人", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-all-a@example.com")
    const userB = await userSession(env, admin, "user-all-b@example.com")

    const space = await createSpace(env, admin, "批量已读空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const pageA = await createPage(env, userA, "A 的文档", space.id)
    const pageB = await createPage(env, userB, "B 的文档", space.id)

    // B 评论 A 两次
    await postComment(env, userB, pageA.id, "评论 1")
    await postComment(env, userB, pageA.id, "评论 2")
    // A 评论 B 一次
    await postComment(env, userA, pageB.id, "评论给 B")

    expect(
      (
        (await (
          await jsonRequest(
            env,
            "GET",
            "/api/notifications/unread-count",
            undefined,
            userA
          )
        ).json()) as { count: number }
      ).count
    ).toBe(2)
    expect(
      (
        (await (
          await jsonRequest(
            env,
            "GET",
            "/api/notifications/unread-count",
            undefined,
            userB
          )
        ).json()) as { count: number }
      ).count
    ).toBe(1)

    // A 调用全部标已读
    const readAllRes = await jsonRequest(
      env,
      "POST",
      "/api/notifications/read-all",
      undefined,
      userA
    )
    expect(readAllRes.status).toBe(200)
    expect(await readAllRes.json()).toEqual({ success: true })

    // A 未读清零，B 未读保持 1
    expect(
      (
        (await (
          await jsonRequest(
            env,
            "GET",
            "/api/notifications/unread-count",
            undefined,
            userA
          )
        ).json()) as { count: number }
      ).count
    ).toBe(0)
    expect(
      (
        (await (
          await jsonRequest(
            env,
            "GET",
            "/api/notifications/unread-count",
            undefined,
            userB
          )
        ).json()) as { count: number }
      ).count
    ).toBe(1)
  })

  it("分页：limit 与 offset 按时间倒序返回", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-paging-a@example.com")
    const userB = await userSession(env, admin, "user-paging-b@example.com")

    const space = await createSpace(env, admin, "分页测试空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "分页文档", space.id)

    // 连续发表 5 条评论
    for (let i = 1; i <= 5; i++) {
      await postComment(env, userB, page.id, `第 ${i} 条评论内容`)
    }

    // 第一页 limit=2 offset=0
    const p1 = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications?limit=2&offset=0",
        undefined,
        userA
      )
    ).json()) as NotificationDto[]
    expect(p1).toHaveLength(2)
    expect(p1[0].excerpt).toBe("第 5 条评论内容")
    expect(p1[1].excerpt).toBe("第 4 条评论内容")

    // 第二页 limit=2 offset=2
    const p2 = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications?limit=2&offset=2",
        undefined,
        userA
      )
    ).json()) as NotificationDto[]
    expect(p2).toHaveLength(2)
    expect(p2[0].excerpt).toBe("第 3 条评论内容")
    expect(p2[1].excerpt).toBe("第 2 条评论内容")

    // 第三页 limit=2 offset=4
    const p3 = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications?limit=2&offset=4",
        undefined,
        userA
      )
    ).json()) as NotificationDto[]
    expect(p3).toHaveLength(1)
    expect(p3[0].excerpt).toBe("第 1 条评论内容")

    // 超出 offset=10
    const p4 = (await (
      await jsonRequest(
        env,
        "GET",
        "/api/notifications?limit=2&offset=10",
        undefined,
        userA
      )
    ).json()) as NotificationDto[]
    expect(p4).toHaveLength(0)
  })

  it("快照保留与截断：纯文本截断 100 字，页面/评论删除后快照仍可读", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-snap-a@example.com")
    const userB = await userSession(env, admin, "user-snap-b@example.com")

    const space = await createSpace(env, admin, "快照空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "原页面标题快照测试", space.id)

    // 构造超过 100 字并带 Markdown 标记的正文
    const repeatText = "测试文本".repeat(30) // 120 字
    const longMarkdown = `# 标题\n\n**加粗**与[链接](https://example.com) ${repeatText}`
    const comment = await postComment(env, userB, page.id, longMarkdown)

    const list = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(list).toHaveLength(1)
    const notif = list[0]
    expect(notif.pageTitle).toBe("原页面标题快照测试")
    // 验证 excerpt 无 HTML/Markdown 标记且长度截断为 100 字
    expect(notif.excerpt).not.toContain("#")
    expect(notif.excerpt).not.toContain("<")
    expect([...notif.excerpt].length).toBe(100)

    // 删除评论后，通知仍然可读，快照不变
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${page.id}/comments/${comment.id}`,
      undefined,
      userB
    )
    const afterDelete = (await (
      await jsonRequest(env, "GET", "/api/notifications", undefined, userA)
    ).json()) as NotificationDto[]
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].pageTitle).toBe("原页面标题快照测试")
    expect(afterDelete[0].excerpt).toBe(notif.excerpt)
  })

  it("鉴权拦截：接口仅限会话，外部令牌拦截 401", async () => {
    const { env } = await initializedContext()
    const prefix = "ciki_"
    const admin = await adminSession(env)
    const adminUserId = await meId(env, admin)

    const agentId = await createAgentUser(env.DB, prefix, {
      username: "token-user",
      owner_user_id: adminUserId
    })
    const { token } = await issueApiToken(env.DB, prefix, agentId, {
      kind: "write",
      name: "write-token"
    })

    // 1. 无凭证调用 → 401
    const unauthRes = await request(env, "/api/notifications")
    expect(unauthRes.status).toBe(401)

    // 2. 带 Bearer 令牌调用 → 401（仅限会话，令牌不可用）
    const tokenRes = await request(env, "/api/notifications", {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(tokenRes.status).toBe(401)

    const tokenCountRes = await request(
      env,
      "/api/notifications/unread-count",
      {
        headers: { authorization: `Bearer ${token}` }
      }
    )
    expect(tokenCountRes.status).toBe(401)

    const tokenReadRes = await request(env, "/api/notifications/1/read", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    })
    expect(tokenReadRes.status).toBe(401)

    const tokenReadAllRes = await request(env, "/api/notifications/read-all", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    })
    expect(tokenReadAllRes.status).toBe(401)
  })

  it("降级容错：通知写入失败（如通知表损坏或被删）不得影响评论创建本身", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const userA = await userSession(env, admin, "user-fault-a@example.com")
    const userB = await userSession(env, admin, "user-fault-b@example.com")

    const space = await createSpace(env, admin, "容错测试空间")
    await addMember(env, admin, space.id, userA, "editor")
    await addMember(env, admin, space.id, userB, "editor")

    const page = await createPage(env, userA, "容错文档", space.id)

    // 故意损坏/删除 notifications 表以触发写入异常
    await env.DB.exec("DROP TABLE ciki_notifications")

    // 发表评论应当照常成功（返回 201）
    const res = await jsonRequest(
      env,
      "POST",
      `/api/pages/${page.id}/comments`,
      { bodyMd: "表损坏时的评论" },
      userB
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; bodyMd: string }
    expect(body.id).toBeGreaterThan(0)
    expect(body.bodyMd).toBe("表损坏时的评论")
  })
})
