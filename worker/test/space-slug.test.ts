/**
 * 空间 slug：URL `/s/<slug>/…` 的唯一来源。
 *
 * 口径（冻结契约）：由空间名派生——小写、非字母数字转 `-`、去首尾 `-`、最多 48 字符；
 * 候选为空（中文名等）或撞名时回落 `space-<id>`，再撞名追加 `-2`、`-3`…；
 * **创建后不随改名变化**（改 URL 会让书签失效）。
 */
import { describe, expect, it } from "vitest"
import {
  spaceSlugCandidate,
  spaceSlugFallback,
  uniqueSpaceSlug
} from "../src/lib/slug"
import { adminSession, initializedContext, jsonRequest } from "./support/app"

interface SpaceDto {
  id: number
  slug: string
  name: string
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
