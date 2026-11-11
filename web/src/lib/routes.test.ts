import { describe, expect, it } from "vitest"
import {
  pageEditPath,
  pagePath,
  parseIdParam,
  spacePath,
  spaceSearchPath,
  spaceSettingsPath,
  spaceTrashPath
} from "@/lib/routes"

describe("数字 id 的路由解析", () => {
  it("只认正整数", () => {
    expect(parseIdParam("1")).toBe(1)
    expect(parseIdParam("42")).toBe(42)
    expect(parseIdParam(undefined)).toBeNull()
    expect(parseIdParam("")).toBeNull()
  })

  it("旧 UUID、零、负数、小数、带单位的一律当作不存在", () => {
    expect(parseIdParam("0f3c1a2b-4d5e-4f60-8a9b-0c1d2e3f4a5b")).toBeNull()
    expect(parseIdParam("0")).toBeNull()
    expect(parseIdParam("-3")).toBeNull()
    expect(parseIdParam("1.5")).toBeNull()
    expect(parseIdParam("1abc")).toBeNull()
    expect(parseIdParam(" 1")).toBeNull()
  })
})

describe("链接生成", () => {
  it("页面地址是全局的数字形态", () => {
    expect(pagePath(12)).toBe("/p/12")
    expect(pageEditPath(12)).toBe("/p/12/edit")
  })

  it("空间上下文一律经 slug", () => {
    expect(spacePath("pay-team")).toBe("/s/pay-team")
    expect(spaceTrashPath("pay-team")).toBe("/s/pay-team/trash")
    expect(spaceSearchPath("pay-team")).toBe("/s/pay-team/search")
    expect(spaceSearchPath("pay-team", " 部署 ")).toBe(
      "/s/pay-team/search?q=%E9%83%A8%E7%BD%B2"
    )
    expect(spaceSettingsPath("pay-team")).toBe("/s/pay-team/settings")
  })

  it("slug 里有需要转义的字符时照样能拼出地址", () => {
    expect(spacePath("a b")).toBe("/s/a%20b")
  })
})
