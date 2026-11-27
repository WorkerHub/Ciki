import { describe, expect, it } from "vitest"
import type { Space } from "@/lib/api"
import {
  canEdit,
  canManage,
  editableSpaces,
  isValidSpaceSlug,
  MAX_SPACE_SLUG_LENGTH,
  spaceSlugCandidate,
  effectiveRole,
  pickInitialSpace,
  roleForSpace
} from "@/lib/space"

function space(overrides: Partial<Space>): Space {
  return {
    id: 1,
    slug: "space-1",
    name: "空间一",
    description: "",
    myRole: "viewer",
    isDefault: false,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides
  }
}

describe("空间角色口径", () => {
  it("站点管理员在任何空间的有效角色都是管理员", () => {
    expect(effectiveRole(space({ myRole: "viewer" }), true)).toBe("admin")
    expect(effectiveRole(space({ myRole: "editor" }), false)).toBe("editor")
  })

  it("editor 可写不可管，viewer 两项都不行", () => {
    expect(canEdit("editor")).toBe(true)
    expect(canManage("editor")).toBe(false)
    expect(canEdit("viewer")).toBe(false)
    expect(canManage("viewer")).toBe(false)
    expect(canEdit(null)).toBe(false)
    expect(canManage("admin")).toBe(true)
  })

  it("空间不在列表里时角色是 null（写入口全部不渲染）", () => {
    const spaces = [space({ id: 1 }), space({ id: 2, myRole: "editor" })]
    expect(roleForSpace(spaces, 2, false)).toBe("editor")
    expect(roleForSpace(spaces, 99, false)).toBeNull()
    expect(roleForSpace(spaces, null, false)).toBeNull()
    expect(roleForSpace(spaces, 1, true)).toBe("admin")
  })
})

describe("进入应用时的当前空间", () => {
  const fallback = space({ id: 10, isDefault: true })
  const other = space({ id: 2, myRole: "editor" })
  const spaces = [fallback, other]

  it("优先本机记住的 id", () => {
    expect(pickInitialSpace(spaces, 2)?.id).toBe(2)
  })

  it("持久 id 失效（空间被删 / 不再是成员）时回落默认空间", () => {
    expect(pickInitialSpace(spaces, 99)?.id).toBe(10)
    expect(pickInitialSpace(spaces, null)?.id).toBe(10)
  })

  it("没有默认空间时取第一个，空列表返回 null", () => {
    expect(pickInitialSpace([other], 99)?.id).toBe(2)
    expect(pickInitialSpace([], 1)).toBeNull()
  })
})

describe("移动页面的目标空间", () => {
  const spaces = [
    space({ id: 1, myRole: "admin" }),
    space({ id: 2, myRole: "editor" }),
    space({ id: 3, myRole: "viewer" })
  ]

  it("只留当前用户可编辑的空间（含页面当前所在空间）", () => {
    expect(editableSpaces(spaces, false).map((item) => item.id)).toEqual([1, 2])
  })

  it("站点管理员对所有空间都有编辑权", () => {
    expect(editableSpaces(spaces, true).map((item) => item.id)).toEqual([
      1, 2, 3
    ])
  })
})

describe("空间 slug 校验规则", () => {
  it("合法的 slug：小写字母、数字、单连字符分段，1–48 位", () => {
    expect(isValidSpaceSlug("a")).toBe(true)
    expect(isValidSpaceSlug("0")).toBe(true)
    expect(isValidSpaceSlug("pay-team")).toBe(true)
    expect(isValidSpaceSlug("team-1-prod")).toBe(true)
    expect(isValidSpaceSlug("a".repeat(MAX_SPACE_SLUG_LENGTH))).toBe(true)
  })

  it("不合法的 slug：空串、超长、大写、特殊字符、连字符首尾或连续", () => {
    expect(isValidSpaceSlug("")).toBe(false)
    expect(isValidSpaceSlug("a".repeat(MAX_SPACE_SLUG_LENGTH + 1))).toBe(false)
    expect(isValidSpaceSlug("Pay-team")).toBe(false)
    expect(isValidSpaceSlug("pay_team")).toBe(false)
    expect(isValidSpaceSlug("pay team")).toBe(false)
    expect(isValidSpaceSlug("-pay")).toBe(false)
    expect(isValidSpaceSlug("pay-")).toBe(false)
    expect(isValidSpaceSlug("pay--team")).toBe(false)
    expect(isValidSpaceSlug("pay/team")).toBe(false)
  })
})

describe("空间 slug 候选生成规则", () => {
  it("常规英文转小写与连字符连接", () => {
    expect(spaceSlugCandidate("Research Lab")).toBe("research-lab")
    expect(spaceSlugCandidate("  A  B  ")).toBe("a-b")
    expect(spaceSlugCandidate("C++ / Rust")).toBe("c-rust")
  })

  it("超长截断至 48 位并清洗末尾连字符", () => {
    expect(spaceSlugCandidate("x".repeat(80))).toBe("x".repeat(48))
    expect(spaceSlugCandidate(`${"x".repeat(47)}-tail`)).toBe("x".repeat(47))
  })

  it("纯中文等非 ASCII 字符返回空串", () => {
    expect(spaceSlugCandidate("默认空间")).toBe("")
    expect(spaceSlugCandidate("研发 空间")).toBe("")
  })

  it("中英混合提取英文字段并规整", () => {
    expect(spaceSlugCandidate("研发 Lab 2026")).toBe("lab-2026")
  })
})
