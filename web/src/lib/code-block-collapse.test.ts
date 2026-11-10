import { describe, expect, it } from "vitest"
import {
  AUTO_COLLAPSE_LINE_THRESHOLD,
  codeLineCount,
  resolveInitialCollapsed
} from "@/lib/code-block-collapse"

/** n 行代码：line 1 … line n（与单 A 夹具 codeText 同形）。 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(
    "\n"
  )
}

describe("代码块行数口径", () => {
  it("空块记 0 行", () => {
    expect(codeLineCount("")).toBe(0)
  })

  it("末尾单个换行不算多一行，连续空行照算", () => {
    expect(codeLineCount("a")).toBe(1)
    expect(codeLineCount("a\n")).toBe(1)
    expect(codeLineCount("a\nb\n")).toBe(2)
    expect(codeLineCount("a\n\n")).toBe(2)
  })

  it("30 行块就是 30 行", () => {
    expect(codeLineCount(lines(30))).toBe(30)
  })
})

describe("阅读页初始折叠：三态", () => {
  it("显式 true 始终折叠、显式 false 始终展开，与行数无关", () => {
    expect(resolveInitialCollapsed(true, lines(1))).toBe(true)
    expect(resolveInitialCollapsed(true, lines(30))).toBe(true)
    expect(resolveInitialCollapsed(false, lines(1))).toBe(false)
    expect(resolveInitialCollapsed(false, lines(30))).toBe(false)
  })

  it("未表态（null / 缺省）走自动规则：> 20 行折叠", () => {
    expect(AUTO_COLLAPSE_LINE_THRESHOLD).toBe(20)
    expect(resolveInitialCollapsed(null, lines(20))).toBe(false)
    expect(resolveInitialCollapsed(null, lines(21))).toBe(true)
    expect(resolveInitialCollapsed(null, lines(30))).toBe(true)
    expect(resolveInitialCollapsed(undefined, lines(10))).toBe(false)
    expect(resolveInitialCollapsed(null, "")).toBe(false)
  })

  it("脏值（字符串 / 数字）按未表态处理，不报错", () => {
    expect(resolveInitialCollapsed("true", lines(10))).toBe(false)
    expect(resolveInitialCollapsed("true", lines(30))).toBe(true)
    expect(resolveInitialCollapsed(1, lines(10))).toBe(false)
    expect(resolveInitialCollapsed({}, lines(30))).toBe(true)
  })
})
