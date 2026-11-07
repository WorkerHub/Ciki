import { describe, expect, it } from "vitest"
import {
  DEFAULT_TABLE_PREFIX,
  ensureTrailingUnderscore,
  getTablePrefix,
  isValidTablePrefix
} from "../src/lib/table-prefix"

/** 用最小形状模拟 env.TABLE_PREFIX 的三种来源。 */
function envWith(tablePrefix: string | null | undefined) {
  return { TABLE_PREFIX: tablePrefix }
}

describe("getTablePrefix 三态解析", () => {
  it("未配置（undefined）→ 默认前缀，补尾下划线", () => {
    expect(getTablePrefix(envWith(undefined))).toBe("ciki_")
  })

  it("未配置（null）→ 默认前缀，补尾下划线", () => {
    expect(getTablePrefix(envWith(null))).toBe("ciki_")
  })

  it("env 里根本没有 TABLE_PREFIX 这个键 → 默认前缀", () => {
    expect(getTablePrefix({})).toBe("ciki_")
  })

  it("自定义值补尾下划线", () => {
    expect(getTablePrefix(envWith("wiki"))).toBe("wiki_")
  })

  it("自定义值已带尾下划线则原样保留", () => {
    expect(getTablePrefix(envWith("wiki_"))).toBe("wiki_")
  })

  it("自定义值保留大小写（与 eNotify 现行规范化一致）", () => {
    expect(getTablePrefix(envWith("Ciki"))).toBe("Ciki_")
  })

  it("显式空串 → 完全无前缀", () => {
    expect(getTablePrefix(envWith(""))).toBe("")
  })

  it("默认前缀常量是裸值，规范化后才带下划线", () => {
    expect(DEFAULT_TABLE_PREFIX).toBe("ciki")
    expect(ensureTrailingUnderscore(DEFAULT_TABLE_PREFIX)).toBe("ciki_")
  })

  it("ensureTrailingUnderscore 不重复加下划线", () => {
    expect(ensureTrailingUnderscore("a_")).toBe("a_")
    expect(ensureTrailingUnderscore("a")).toBe("a_")
  })
})

describe("isValidTablePrefix 校验非法字符", () => {
  it("字母或下划线开头、只含字母数字下划线（含空串）合法", () => {
    for (const ok of ["ciki_", "ciki", "a1_b2", "", "Ciki_", "_ciki"]) {
      expect(isValidTablePrefix(ok)).toBe(true)
    }
  })

  it("连字符、分号、空格、引号、点等一律非法", () => {
    for (const bad of [
      "ci-ki",
      "ciki;drop",
      "ciki ",
      " ciki",
      "ciki'",
      "ciki.",
      "ciki/../x"
    ]) {
      expect(isValidTablePrefix(bad)).toBe(false)
    }
  })

  it("前导数字非法：2026_pages / 1abc_pages 不是合法 SQL 标识符", () => {
    for (const bad of ["2026", "1abc", "2026_"]) {
      expect(isValidTablePrefix(bad)).toBe(false)
    }
  })
})
