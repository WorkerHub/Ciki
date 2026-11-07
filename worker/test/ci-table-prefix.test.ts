/**
 * CI 侧解析（scripts/resolve-table-prefix.mjs）与运行时解析（src/lib/table-prefix.ts）
 * 必须在同一份输入上得出同一个生效前缀——否则 GitHub Variables 里写的东西和线上
 * 实际建的表会悄悄错位。这条测试就是两份实现的锁：改任何一边，这里先红。
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_TABLE_PREFIX as CI_DEFAULT,
  NO_PREFIX_KEYWORD,
  isUsablePrefix,
  resolveForCi
} from "../../scripts/resolve-table-prefix.mjs"
import {
  DEFAULT_TABLE_PREFIX,
  getTablePrefix,
  isValidTablePrefix
} from "../src/lib/table-prefix"

/** CI 注入 wrangler [vars] 的值，最终由运行时解析成生效前缀。 */
function effectiveFromCi(raw: string | undefined): string {
  return getTablePrefix({ TABLE_PREFIX: resolveForCi(raw) })
}

describe("默认前缀常量两边同值", () => {
  it("CI 与运行时的 DEFAULT_TABLE_PREFIX 一致", () => {
    expect(CI_DEFAULT).toBe(DEFAULT_TABLE_PREFIX)
    expect(CI_DEFAULT).toBe("ciki")
  })

  it("“无前缀”保留字是 none", () => {
    expect(NO_PREFIX_KEYWORD).toBe("none")
  })
})

describe("GitHub Variables → 生效前缀", () => {
  it("未设置 / 空串 → 默认前缀 ciki_", () => {
    expect(effectiveFromCi(undefined)).toBe("ciki_")
    expect(effectiveFromCi("")).toBe("ciki_")
  })

  it("保留字 none → 无前缀", () => {
    expect(resolveForCi("none")).toBe("")
    expect(effectiveFromCi("none")).toBe("")
  })

  it("自定义值原样注入，运行时补尾下划线", () => {
    expect(resolveForCi("wiki")).toBe("wiki")
    expect(effectiveFromCi("wiki")).toBe("wiki_")
    expect(effectiveFromCi("wiki_")).toBe("wiki_")
  })

  it("“none” 作为自定义前缀会被当成保留字，不可能得到 none_", () => {
    expect(effectiveFromCi("NONE")).toBe("NONE_")
  })
})

describe("前缀校验两边同规则", () => {
  it("CI 与运行时接受/拒绝同一批值", () => {
    const samples = ["ciki_", "", "wiki", "Ciki_1", "ci-ki", "ciki ", "ciki;"]
    for (const sample of samples) {
      expect(isUsablePrefix(sample)).toBe(isValidTablePrefix(sample))
    }
  })

  it("CI 在注入前就能拦下非法自定义值", () => {
    expect(isUsablePrefix(resolveForCi("ci-ki"))).toBe(false)
  })
})
