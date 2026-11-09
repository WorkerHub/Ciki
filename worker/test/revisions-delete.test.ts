/**
 * 手动删除历史版本（规格「手动删除历史版本」）。
 *
 * 覆盖验收：删中间版本成功且列表即时更新、其余版本查看与回滚不受影响；删最新一条
 * 被拒；只读成员看不到也调不动（服务端 403）、非成员 404；批量「只留最新一条」生效。
 * 并逐项确认删除只动版本行：页面当前内容、FTS、R2 对象全不变。
 */
import { describe, expect, it } from "vitest"
import { deleteRevision as deleteRevisionQuery } from "../src/db/queries/revisions"
import { initializedContext, jsonRequest } from "./support/app"
import {
  adminWithPage,
  countRevisionsInDb,
  createPage,
  deleteRevision,
  getRevision,
  listRevisions,
  pageSnapshot,
  outsiderSession,
  prunePageRevisions,
  restoreRevision,
  savePage,
  viewerSession
} from "./support/revisions"

/** 建一页并连存三次，返回版本列表（新 → 旧）：[v3, v2, v1, 创建快照]。 */
async function pageWithHistory(
  context: Awaited<ReturnType<typeof initializedContext>>
) {
  const { env, admin, page } = await adminWithPage(context, "删除页")
  for (const text of ["第二版", "第三版", "第四版"]) {
    await savePage(env, admin, page.id, { title: "删除页", text })
  }
  const revisions = await listRevisions(env, admin, page.id)
  expect(revisions).toHaveLength(4)
  return { env, admin, page, revisions }
}

describe("手动删除版本：单条", () => {
  it("删中间版本成功、列表即时更新，其余版本查看与回滚照常", async () => {
    const context = await initializedContext()
    const { env, admin, page, revisions } = await pageWithHistory(context)
    const middle = revisions[1]
    const snapshot = pageSnapshot(context.db, page.id)

    const res = await deleteRevision(env, admin, page.id, middle.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    const after = await listRevisions(env, admin, page.id)
    expect(after).toHaveLength(3)
    expect(after.map((revision) => revision.id)).not.toContain(middle.id)

    // 删除只动版本行：页面当前内容与 FTS 一字未变（回滚会写页面，所以先比）。
    expect(pageSnapshot(context.db, page.id)).toEqual(snapshot)

    // 其余版本照常查看与回滚（删中间版本不影响别的版本）。
    for (const revision of after) {
      const detail = await getRevision(env, admin, page.id, revision.id)
      expect(detail.status).toBe(200)
    }
    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      after.at(-1)?.id ?? ""
    )
    expect(restore.status).toBe(200)
  })

  it("删最新一条被拒（409 REVISION_IS_LATEST），一条也不少", async () => {
    const context = await initializedContext()
    const { env, admin, page, revisions } = await pageWithHistory(context)

    const res = await deleteRevision(env, admin, page.id, revisions[0].id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "REVISION_IS_LATEST" })
    expect(countRevisionsInDb(context.db, page.id)).toBe(4)
  })

  it("没有这个版本（或不属于该页）→ 404", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await pageWithHistory(context)
    const other = await createPage(env, admin, { title: "别的页" })

    const missing = await deleteRevision(
      env,
      admin,
      page.id,
      "00000000-0000-4000-8000-000000000000"
    )
    expect(missing.status).toBe(404)

    // 拿别的页的版本 id 来删：按「不存在」处理，不跨页删。
    const foreignRevision = (await listRevisions(env, admin, other.id))[0]
    const foreign = await deleteRevision(
      env,
      admin,
      page.id,
      foreignRevision.id
    )
    expect(foreign.status).toBe(404)
    expect(countRevisionsInDb(context.db, other.id)).toBe(1)
  })

  it("只读成员 403、非成员 404、回收站页面 404", async () => {
    const context = await initializedContext()
    const { env, admin, page, revisions } = await pageWithHistory(context)
    const viewer = await viewerSession(env, admin)
    const outsider = await outsiderSession(env, admin)

    const asEditor = await deleteRevision(env, admin, page.id, revisions[1].id)
    expect(asEditor.status).toBe(200)

    // 只读成员：能看历史，但删除接口 403（不能只靠前端隐藏）。
    const viewerDelete = await deleteRevision(
      env,
      viewer,
      page.id,
      revisions[2].id
    )
    expect(viewerDelete.status).toBe(403)

    // 非成员：按页面不存在处理，不泄露存在性。
    const outsiderDelete = await deleteRevision(
      env,
      outsider,
      page.id,
      revisions[2].id
    )
    expect(outsiderDelete.status).toBe(404)
    expect(countRevisionsInDb(context.db, page.id)).toBe(3)

    // 已软删的页面：版本删除按不存在处理（与回滚同一口径）。
    const trashed = await createPage(env, admin, { title: "回收站页" })
    await savePage(env, admin, trashed.id, {
      title: "回收站页",
      text: "第二版"
    })
    await jsonRequest(
      env,
      "DELETE",
      `/api/pages/${trashed.id}`,
      undefined,
      admin
    )
    const trashedRevisions = await listRevisions(env, admin, trashed.id)
    const onTrashed = await deleteRevision(
      env,
      admin,
      trashed.id,
      trashedRevisions.at(-1)?.id ?? ""
    )
    expect(onTrashed.status).toBe(404)
  })
})

describe("手动删除版本：护栏在 SQL 里（不靠先读后写）", () => {
  it("直接执行删除语句：最新一条删不动（0 行），中间版本删得掉（1 行）", async () => {
    const context = await initializedContext()
    const { env, admin, page, revisions } = await pageWithHistory(context)

    // 绕过路由的 409 判断，直接把「最新一条」交给 DELETE：WHERE 里的护栏必须拒掉它。
    const onLatest = await deleteRevisionQuery(
      env.DB,
      "ciki_",
      page.id,
      revisions[0].id
    )
    expect(onLatest).toBe(0)
    expect(countRevisionsInDb(context.db, page.id)).toBe(4)

    const onMiddle = await deleteRevisionQuery(
      env.DB,
      "ciki_",
      page.id,
      revisions[2].id
    )
    expect(onMiddle).toBe(1)
    expect(
      (await listRevisions(env, admin, page.id)).map((r) => r.id)
    ).toContain(revisions[0].id)
  })
})

describe("手动删除版本：按页批量只留最新一条", () => {
  it("批量生效：只剩最新一条，删除数与预告一致，页面内容不变", async () => {
    const context = await initializedContext()
    const { env, admin, page, revisions } = await pageWithHistory(context)
    const snapshot = pageSnapshot(context.db, page.id)

    const res = await prunePageRevisions(env, admin, page.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 3 })

    const after = await listRevisions(env, admin, page.id)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(revisions[0].id)
    // 留下的那条就是当前内容：用它回滚是无改动。
    const restore = await restoreRevision(env, admin, page.id, after[0].id)
    expect(restore.status).toBe(200)
    expect(countRevisionsInDb(context.db, page.id)).toBe(1)

    // 页面当前内容与 FTS 全程未变。
    const afterPrune = pageSnapshot(context.db, page.id)
    expect(afterPrune.fts).toEqual(snapshot.fts)
    expect((afterPrune.page as { content_text: string }).content_text).toBe(
      (snapshot.page as { content_text: string }).content_text
    )

    // 再点一次：没有可删的了。
    const again = await prunePageRevisions(env, admin, page.id)
    expect(await again.json()).toEqual({ deleted: 0 })
  })

  it("只读成员 403，版本一条不少", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await pageWithHistory(context)
    const viewer = await viewerSession(env, admin)

    const res = await prunePageRevisions(env, viewer, page.id)
    expect(res.status).toBe(403)
    expect(countRevisionsInDb(context.db, page.id)).toBe(4)
  })
})
