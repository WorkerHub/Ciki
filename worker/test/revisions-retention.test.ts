/**
 * 保留数设置（规格「保留数设置」）。
 *
 * 覆盖验收：N=3 连存 5 次 → 恰 3 条且为最新 3 条；设不限 → 不修剪；全站修剪 →
 * 所有页收敛到 N、删除总数与预告一致；导入与回滚同样走这条修剪。
 */
import { describe, expect, it } from "vitest"
import {
  initializedContext,
  jsonRequest,
  request,
  userSession
} from "./support/app"
import {
  adminWithPage,
  countRevisionsInDb,
  createPage,
  getSettings,
  listRevisions,
  pageSnapshot,
  pruneAllRevisions,
  putSettings,
  retentionPreview,
  restoreRevision,
  revisionRows,
  savePage,
  viewerSession
} from "./support/revisions"

/** 连存若干次，返回每次保存后「最新一条版本」的 id（新 → 旧）。 */
async function saveTimes(
  env: Parameters<typeof savePage>[0],
  cookie: string,
  pageId: number,
  title: string,
  times: number
): Promise<number[]> {
  const ids: number[] = []
  for (let index = 0; index < times; index += 1) {
    await savePage(env, cookie, pageId, {
      title,
      text: `${title} 第 ${index + 1} 次保存`
    })
    ids.push((await listRevisions(env, cookie, pageId))[0].versionNo)
  }
  return ids
}

describe("保留数：设置口径", () => {
  it("默认不限（null）；0、空串都归一化成不限；非法值 400", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context)

    expect((await getSettings(env, admin)).revisionRetentionLimit).toBeNull()

    for (const value of [3, 1]) {
      expect(
        (await putSettings(env, admin, { revisionRetentionLimit: value }))
          .status
      ).toBe(200)
      expect((await getSettings(env, admin)).revisionRetentionLimit).toBe(value)
    }

    for (const value of [0, null, ""]) {
      expect(
        (await putSettings(env, admin, { revisionRetentionLimit: value }))
          .status
      ).toBe(200)
      const settings = await getSettings(env, admin)
      expect(settings.revisionRetentionLimit).toBeNull()
    }

    for (const value of [-1, 1.5, "abc", true]) {
      const res = await putSettings(env, admin, {
        revisionRetentionLimit: value
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(
        "revisionRetentionLimit must be a positive integer or null"
      )
    }
  })

  it("修剪接口只对站点管理员开放（普通成员 403）", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context)
    const member = await userSession(env, admin, "member@example.com")

    const preview = await jsonRequest(
      env,
      "GET",
      "/api/admin/revisions/retention",
      undefined,
      member
    )
    expect(preview.status).toBe(403)
    const prune = await jsonRequest(
      env,
      "POST",
      "/api/admin/revisions/prune",
      undefined,
      member
    )
    expect(prune.status).toBe(403)
    const put = await putSettings(env, member, { revisionRetentionLimit: 3 })
    expect(put.status).toBe(403)
  })
})

describe("保留数：写入时修剪", () => {
  it("设 N=3，连存 5 次不同内容 → 恰 3 条且是最新 3 条", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "保留页")
    await putSettings(env, admin, { revisionRetentionLimit: 3 })

    const newestIds = await saveTimes(env, admin, page.id, "保留页", 5)
    const revisions = await listRevisions(env, admin, page.id)
    expect(revisions.map((revision) => revision.versionNo)).toEqual(
      newestIds.slice(-3).reverse()
    )
    expect(countRevisionsInDb(context.db, page.id)).toBe(3)
    // 剪掉的只是版本行，页面当前内容仍是最后一次保存的那份。
    const current = (await (
      await jsonRequest(env, "GET", `/api/pages/${page.id}`, undefined, admin)
    ).json()) as { contentText: string }
    expect(current.contentText).toBe("保留页 第 5 次保存")
  })

  it("不限（默认）→ 连存 5 次全部保留，一条都不剪", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "不限页")

    const newestIds = await saveTimes(env, admin, page.id, "不限页", 5)
    const revisions = await listRevisions(env, admin, page.id)
    expect(revisions).toHaveLength(6)
    expect(revisions.map((revision) => revision.versionNo).slice(0, 5)).toEqual(
      newestIds.slice().reverse()
    )
  })

  it("N=1：只留最新一条，最新一条永远是当前内容的快照", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "只留一条")
    await putSettings(env, admin, { revisionRetentionLimit: 1 })

    const newestIds = await saveTimes(env, admin, page.id, "只留一条", 3)
    expect(countRevisionsInDb(context.db, page.id)).toBe(1)
    expect((await listRevisions(env, admin, page.id))[0].versionNo).toBe(
      newestIds[newestIds.length - 1]
    )
  })

  it("回滚路径同样修剪（回滚是一次正常保存，生成新版本后按上限剪）", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "回滚修剪页")
    const first = await savePage(env, admin, page.id, {
      title: "回滚修剪页",
      text: "第一版"
    })
    await savePage(env, admin, page.id, { title: "回滚修剪页", text: "第二版" })
    await savePage(env, admin, page.id, { title: "回滚修剪页", text: "第三版" })
    await putSettings(env, admin, { revisionRetentionLimit: 2 })

    const firstVersion = (await listRevisions(env, admin, page.id)).at(-2)
    if (!firstVersion) throw new Error("revision missing")
    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      firstVersion?.versionNo ?? 0
    )
    expect(restore.status).toBe(200)
    expect(
      ((await restore.json()) as { contentText: string }).contentText
    ).toBe("第一版")
    expect(countRevisionsInDb(context.db, page.id)).toBe(2)
    expect(first.id).toBe(page.id)
  })

  it("导入更新同名页也走同一条修剪", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context)
    await putSettings(env, admin, { revisionRetentionLimit: 2 })

    const tokenRes = await jsonRequest(
      env,
      "POST",
      "/api/me/import-token",
      undefined,
      admin
    )
    expect(tokenRes.status).toBe(200)
    const { token } = (await tokenRes.json()) as { token: string }

    let pageId = ""
    for (let index = 0; index < 4; index += 1) {
      const res = await request(env, "/api/import/pages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          title: "导入保留页",
          parentId: null,
          contentJson: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: `第 ${index} 次导入` }]
              }
            ]
          }),
          conflict: "update"
        })
      })
      expect([200, 201]).toContain(res.status)
      pageId = ((await res.json()) as { pageId: string }).pageId
    }

    expect(countRevisionsInDb(context.db, pageId)).toBe(2)
  })
})

describe("保留数：手动全站修剪", () => {
  it("预告条数与实际删除条数一致，所有页收敛到 N，页面内容与 FTS 不动", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context)
    const a = await createPage(env, admin, { title: "甲" })
    const b = await createPage(env, admin, { title: "乙" })
    await saveTimes(env, admin, a.id, "甲", 4)
    await saveTimes(env, admin, b.id, "乙", 2)
    // 甲 5 条、乙 3 条、再加上初始页 1 条。
    expect(countRevisionsInDb(context.db)).toBe(9)

    await putSettings(env, admin, { revisionRetentionLimit: 2 })
    const snapshotA = pageSnapshot(context.db, a.id)
    const snapshotB = pageSnapshot(context.db, b.id)

    const preview = await retentionPreview(env, admin)
    expect(preview).toEqual({
      limit: 2,
      totalRevisions: 9,
      prunableRevisions: 3 + 1
    })

    const res = await pruneAllRevisions(env, admin)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { limit: number; deleted: number }
    expect(body).toEqual({ limit: 2, deleted: preview.prunableRevisions })

    // 每页收敛到 2 条，且留下的都是最新两条（version_no 递增、留尾部）。
    for (const pageId of [a.id, b.id]) {
      const rows = revisionRows(context.db, pageId)
      expect(rows).toHaveLength(2)
      expect(rows.at(-1)?.version_no).toBeGreaterThan(rows[0].version_no)
      expect(rows.at(-1)?.content_hash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(countRevisionsInDb(context.db)).toBe(5)

    // 只删版本行：页面当前内容与 FTS 索引一字未变。
    expect(pageSnapshot(context.db, a.id)).toEqual(snapshotA)
    expect(pageSnapshot(context.db, b.id)).toEqual(snapshotB)

    // 再点一次：没有可删的了，删除数为 0（幂等）。
    const again = await pruneAllRevisions(env, admin)
    expect((await again.json()) as { deleted: number }).toEqual({
      limit: 2,
      deleted: 0
    })
  })

  it("不限时修剪接口 409 RETENTION_UNLIMITED，一条也不删", async () => {
    const context = await initializedContext()
    const { env, admin } = await adminWithPage(context)
    await saveTimes(
      env,
      admin,
      (await createPage(env, admin, { title: "页" })).id,
      "页",
      3
    )
    const before = countRevisionsInDb(context.db)

    const res = await pruneAllRevisions(env, admin)
    expect(res.status).toBe(409)
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "RETENTION_UNLIMITED"
    })
    expect(countRevisionsInDb(context.db)).toBe(before)
    expect(await retentionPreview(env, admin)).toEqual({
      limit: null,
      totalRevisions: before,
      prunableRevisions: 0
    })
  })

  it("只读成员看不到也调不动（服务端 403）", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "只读页")
    const viewer = await viewerSession(env, admin)
    await putSettings(env, admin, { revisionRetentionLimit: 1 })
    await saveTimes(env, admin, page.id, "只读页", 2)

    const res = await pruneAllRevisions(env, viewer)
    expect(res.status).toBe(403)
    expect(countRevisionsInDb(context.db, page.id)).toBe(1)
  })
})
