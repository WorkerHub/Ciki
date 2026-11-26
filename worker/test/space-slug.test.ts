/**
 * 空间 slug：URL `/s/<slug>/…` 的唯一来源。
 *
 * 口径（冻结契约）：由空间名派生——小写、非字母数字转 `-`、去首尾 `-`、最多 48 字符；
 * 候选为空（中文名等）或撞名时回落 `space-<id>`，再撞名追加 `-2`、`-3`…；
 * **创建后不随改名变化**（改 URL 会让书签失效）。
 * 可在空间设置中手动修改（PUT /api/spaces/:id 开放 slug 编辑，带格式与唯一性校验）。
 */
import { describe, expect, it } from "vitest"
import {
  isSpaceSlugConflict,
  isValidSpaceSlug,
  spaceSlugCandidate,
  spaceSlugFallback,
  uniqueSpaceSlug
} from "../src/lib/slug"
import {
  adminSession,
  initializedContext,
  jsonRequest,
  userSession
} from "./support/app"

interface SpaceDto {
  id: number
  slug: string
  name: string
  description?: string
}

describe("slug 纯函数", () => {
  it("ASCII 名称：小写、非字母数字转连字符、去首尾连字符、截断 48", () => {
    expect(spaceSlugCandidate("Research Lab")).toBe("research-lab")
    expect(spaceSlugCandidate("  A  B  ")).toBe("a-b")
    expect(spaceSlugCandidate("C++ / Rust")).toBe("c-rust")
    expect(spaceSlugCandidate("x".repeat(80))).toHaveLength(48)
    expect(spaceSlugCandidate(`${"x".repeat(47)}-tail`)).toHaveLength(47)
  })

  it("没有任何 ASCII 字母数字的名称（中文等）候选为空串", () => {
    expect(spaceSlugCandidate("默认空间")).toBe("")
    expect(spaceSlugCandidate("研发 空间")).toBe("")
    expect(spaceSlugFallback(3)).toBe("space-3")
  })

  it("撞名收敛：候选被占就用 space-<id>，仍被占就追加 -2、-3…", () => {
    expect(uniqueSpaceSlug("Team", 2, () => false)).toBe("team")
    // 「team」已被占：回落到 space-2
    expect(uniqueSpaceSlug("Team", 2, (slug) => slug === "team")).toBe(
      "space-2"
    )
    // 连兜底也被占：继续加后缀
    expect(
      uniqueSpaceSlug(
        "Team",
        2,
        (slug) => slug === "team" || slug === "space-2"
      )
    ).toBe("space-2-2")
  })

  it("isValidSpaceSlug: 合法小写、数字、单连字符分段且 ≤48 字符", () => {
    expect(isValidSpaceSlug("a")).toBe(true)
    expect(isValidSpaceSlug("0")).toBe(true)
    expect(isValidSpaceSlug("research-lab")).toBe(true)
    expect(isValidSpaceSlug("lab-123-alpha")).toBe(true)
    expect(isValidSpaceSlug("x".repeat(48))).toBe(true)

    // 非法情形
    expect(isValidSpaceSlug("")).toBe(false)
    expect(isValidSpaceSlug("x".repeat(49))).toBe(false)
    expect(isValidSpaceSlug("-research")).toBe(false)
    expect(isValidSpaceSlug("research-")).toBe(false)
    expect(isValidSpaceSlug("research--lab")).toBe(false)
    expect(isValidSpaceSlug("Research")).toBe(false)
    expect(isValidSpaceSlug("research lab")).toBe(false)
    expect(isValidSpaceSlug("research_lab")).toBe(false)
    expect(isValidSpaceSlug("research.lab")).toBe(false)
    expect(isValidSpaceSlug(null)).toBe(false)
    expect(isValidSpaceSlug(undefined)).toBe(false)
    expect(isValidSpaceSlug(123)).toBe(false)
    expect(isValidSpaceSlug({})).toBe(false)
  })

  it("isSpaceSlugConflict: 精确识别 spaces_slug 约束冲突", () => {
    expect(
      isSpaceSlugConflict(
        new Error("UNIQUE constraint failed: ciki_spaces.slug")
      )
    ).toBe(true)
    expect(
      isSpaceSlugConflict(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: ciki_spaces.slug: SQLITE_CONSTRAINT"
        )
      )
    ).toBe(true)
    expect(
      isSpaceSlugConflict(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: ciki_spaces.slug: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"
        )
      )
    ).toBe(true)
    expect(
      isSpaceSlugConflict(
        new Error("UNIQUE constraint failed: index 'ciki_spaces_slug'")
      )
    ).toBe(true)

    // 其它列或表的唯一约束不应误认
    expect(
      isSpaceSlugConflict(
        new Error("UNIQUE constraint failed: ciki_spaces.name")
      )
    ).toBe(false)
    expect(
      isSpaceSlugConflict(
        new Error("UNIQUE constraint failed: ciki_users.username")
      )
    ).toBe(false)
    expect(
      isSpaceSlugConflict(
        new Error("NOT NULL constraint failed: ciki_spaces.slug")
      )
    ).toBe(false)
    expect(isSpaceSlugConflict(new Error("unknown error"))).toBe(false)
  })
})

describe("建空间时落库的 slug", () => {
  it("英文名直接用候选；中文名落 space-<id>；重名空间 slug 互不相同", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)

    const create = async (name: string): Promise<SpaceDto> => {
      const res = await jsonRequest(env, "POST", "/api/spaces", { name }, admin)
      expect(res.status).toBe(201)
      return (await res.json()) as SpaceDto
    }

    const english = await create("Research Lab")
    expect(english.slug).toBe("research-lab")

    const chinese = await create("研发空间")
    expect(chinese.slug).toBe(`space-${chinese.id}`)

    const duplicate = await create("Research Lab")
    expect(duplicate.slug).not.toBe(english.slug)
    expect(duplicate.slug).toBe(`space-${duplicate.id}`)

    // 默认空间在初始化时就有 slug，中文名同样走兜底。
    const spaces = (await (
      await jsonRequest(env, "GET", "/api/spaces", undefined, admin)
    ).json()) as SpaceDto[]
    expect(spaces.map((space) => space.slug)).toContain("space-1")
    const slugs = spaces.map((space) => space.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("改名不动 slug（URL 不因改名失效）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const created = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Research Lab" },
        admin
      )
    ).json()) as SpaceDto

    const renamed = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${created.id}`,
      { name: "另一间实验室" },
      admin
    )
    expect(renamed.status).toBe(200)
    const body = (await renamed.json()) as SpaceDto
    expect(body.name).toBe("另一间实验室")
    expect(body.slug).toBe(created.slug)
  })
})

describe("修改空间 slug (PUT /api/spaces/:id)", () => {
  it("空间 admin 可单独更新 slug，GET 接口与后续查询同步生效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const created = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "My Team Space" },
        admin
      )
    ).json()) as SpaceDto
    expect(created.slug).toBe("my-team-space")

    const updatedRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${created.id}`,
      { slug: "core-team" },
      admin
    )
    expect(updatedRes.status).toBe(200)
    const updated = (await updatedRes.json()) as SpaceDto
    expect(updated.slug).toBe("core-team")

    // GET 详情查出新 slug
    const detailRes = await jsonRequest(
      env,
      "GET",
      `/api/spaces/${created.id}`,
      undefined,
      admin
    )
    expect(detailRes.status).toBe(200)
    expect(((await detailRes.json()) as SpaceDto).slug).toBe("core-team")
  })

  it("同请求更新 name、description 与 slug 时原子生效", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const created = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Old Space", description: "old desc" },
        admin
      )
    ).json()) as SpaceDto

    const res = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${created.id}`,
      {
        name: "New Space",
        description: "new desc",
        slug: "new-space-slug"
      },
      admin
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as SpaceDto
    expect(body.name).toBe("New Space")
    expect(body.description).toBe("new desc")
    expect(body.slug).toBe("new-space-slug")
  })

  it("带了 slug 且与现值相同视为无操作、正常成功 (200)", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const created = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Alpha Space" },
        admin
      )
    ).json()) as SpaceDto

    const noopRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${created.id}`,
      { slug: created.slug },
      admin
    )
    expect(noopRes.status).toBe(200)
    expect(((await noopRes.json()) as SpaceDto).slug).toBe(created.slug)
  })

  it("格式非法返回 400 INVALID_SPACE_SLUG，原 slug 不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const created = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Format Test Space" },
        admin
      )
    ).json()) as SpaceDto

    const invalidSlugs = [
      "",
      "-invalid",
      "invalid-",
      "in--valid",
      "Upper-Case",
      "with space",
      "under_score",
      "x".repeat(49),
      123
    ]

    for (const badSlug of invalidSlugs) {
      const res = await jsonRequest(
        env,
        "PUT",
        `/api/spaces/${created.id}`,
        { slug: badSlug },
        admin
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: "INVALID_SPACE_SLUG" })
    }

    // 原 slug 不变
    const check = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/spaces/${created.id}`,
        undefined,
        admin
      )
    ).json()) as SpaceDto
    expect(check.slug).toBe(created.slug)
  })

  it("与其它空间 slug 冲突返回 409 SPACE_SLUG_TAKEN，整单拒绝且原数据不变", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const spaceA = (await (
      await jsonRequest(env, "POST", "/api/spaces", { name: "Space A" }, admin)
    ).json()) as SpaceDto

    const spaceB = (await (
      await jsonRequest(env, "POST", "/api/spaces", { name: "Space B" }, admin)
    ).json()) as SpaceDto

    // Space B 试图改成 Space A 的 slug，同请求带了改名
    const conflictRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${spaceB.id}`,
      { name: "Space B Renamed", slug: spaceA.slug },
      admin
    )
    expect(conflictRes.status).toBe(409)
    expect(await conflictRes.json()).toMatchObject({ code: "SPACE_SLUG_TAKEN" })

    // 整单拒绝：Space B 的 name 与 slug 均未被改变
    const checkB = (await (
      await jsonRequest(
        env,
        "GET",
        `/api/spaces/${spaceB.id}`,
        undefined,
        admin
      )
    ).json()) as SpaceDto
    expect(checkB.name).toBe("Space B")
    expect(checkB.slug).toBe(spaceB.slug)
  })

  it("name 校验失败时原 slug 不变（整单拒绝）", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const space = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Valid Space" },
        admin
      )
    ).json()) as SpaceDto

    const badNameRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { name: "   ", slug: "should-not-apply" },
      admin
    )
    expect(badNameRes.status).toBe(400)
    expect(await badNameRes.json()).toMatchObject({
      code: "INVALID_SPACE_NAME"
    })

    // 原 slug 不变
    const check = (await (
      await jsonRequest(env, "GET", `/api/spaces/${space.id}`, undefined, admin)
    ).json()) as SpaceDto
    expect(check.slug).toBe(space.slug)
  })

  it("非空间 admin（如 editor、viewer）无权修改 slug，返回 403", async () => {
    const { env } = await initializedContext()
    const admin = await adminSession(env)
    const owner = await userSession(env, admin, "owner@example.com")
    const editor = await userSession(env, admin, "editor@example.com")

    const space = (await (
      await jsonRequest(
        env,
        "POST",
        "/api/spaces",
        { name: "Permission Test Space" },
        owner
      )
    ).json()) as SpaceDto

    const editorProfile = (await (
      await jsonRequest(env, "GET", "/api/me", undefined, editor)
    ).json()) as { id: number }

    // 添加为 editor
    await jsonRequest(
      env,
      "POST",
      `/api/spaces/${space.id}/members`,
      { userId: editorProfile.id, role: "editor" },
      owner
    )

    // editor 尝试修改 slug -> 403
    const deniedRes = await jsonRequest(
      env,
      "PUT",
      `/api/spaces/${space.id}`,
      { slug: "editor-stolen-slug" },
      editor
    )
    expect(deniedRes.status).toBe(403)
  })
})
