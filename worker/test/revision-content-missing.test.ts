/**
 * 版本正文对象缺失（指针脏了/对象被误删）时的口径。
 *
 * 契约：「内容对象整个不见了」与「内容渲染不了」必须分开——前者说明库里指针与内容
 * 桶不一致，是运维问题，回 5xx `CONTENT_MISSING`（与阅读接口取不到 JSON 同口径）；
 * 后者是内容本身的问题，回 422 `REVISION_UNRENDERABLE`。两者都不能写回页面。
 */
import { describe, expect, it } from "vitest"
import { contentObjectKey } from "../src/core/content-store"
import { initializedContext } from "./support/app"
import {
  adminWithPage,
  getRevision,
  pageSnapshot,
  restoreRevision,
  revisionRows
} from "./support/revisions"

describe("版本正文对象缺失", () => {
  it("查看与回滚都回 500 CONTENT_MISSING，页面一字未动", async () => {
    const context = await initializedContext()
    const { env, admin, page } = await adminWithPage(context, "缺对象页")
    const [revision] = revisionRows(context.db, page.id)

    // 只删内容桶里的对象，库里指针原样留着（真实场景：误删/迁移未完成）。
    await env.CONTENT.delete(contentObjectKey(revision.content_hash))
    const snapshot = pageSnapshot(context.db, page.id)

    const view = await getRevision(env, admin, page.id, revision.version_no)
    expect(view.status).toBe(500)
    expect(await view.json()).toEqual({
      error: "Page content unavailable",
      code: "CONTENT_MISSING"
    })

    const restore = await restoreRevision(
      env,
      admin,
      page.id,
      revision.version_no
    )
    expect(restore.status).toBe(500)
    expect(await restore.json()).toEqual({
      error: "Page content unavailable",
      code: "CONTENT_MISSING"
    })

    // 回滚失败不落库：页面行、指针与 FTS 全等。
    expect(pageSnapshot(context.db, page.id)).toEqual(snapshot)
  })
})
