import { describe, expect, it } from "vitest"
import { loadLanguage, lowlight } from "./lowlight"

describe("lowlight 语言包拆分与按需加载", () => {
  it("主路径初始已注册常用核心语言（含 Shell、Bash、JavaScript 等）", () => {
    expect(lowlight.registered("javascript")).toBe(true)
    expect(lowlight.registered("typescript")).toBe(true)
    expect(lowlight.registered("python")).toBe(true)
    expect(lowlight.registered("bash")).toBe(true)
    expect(lowlight.registered("shell")).toBe(true)
    expect(lowlight.registered("sql")).toBe(true)
    expect(lowlight.registered("json")).toBe(true)
    expect(lowlight.registered("xml")).toBe(true)
    expect(lowlight.registered("css")).toBe(true)
    expect(lowlight.registered("markdown")).toBe(true)
    expect(lowlight.registered("yaml")).toBe(true)
  })

  it("冷门语言初始未注册，按需触发 loadLanguage 成功注册并保留语法高亮", async () => {
    // Rust 属于按需加载语言
    expect(lowlight.registered("rust")).toBe(false)

    const loaded = await loadLanguage("rust")
    expect(loaded).toBe(true)
    expect(lowlight.registered("rust")).toBe(true)

    // 高亮结果正常产生 tokens
    const tree = lowlight.highlight("rust", 'fn main() { println!("ok"); }')
    expect(tree.type).toBe("root")
    expect(tree.children.length).toBeGreaterThan(0)
  })

  it("语言别名可正常识别并加载对应语言包", async () => {
    expect(lowlight.registered("kotlin")).toBe(false)
    // 使用别名 kt
    const loaded = await loadLanguage("kt")
    expect(loaded).toBe(true)
    expect(lowlight.registered("kotlin")).toBe(true)
  })

  it("未知或非法语言安全降级：返回 false，highlight 降级为空结果，不抛错", async () => {
    const loaded = await loadLanguage("totally_unknown_lang_xyz")
    expect(loaded).toBe(false)

    // 不抛异常，返回空 children（降级为无高亮纯文本）
    const res = lowlight.highlight("totally_unknown_lang_xyz", "some code text")
    expect(res).toEqual({ type: "root", children: [] })
  })

  it("未标注语言的代码块保留 highlightAuto 自动推断，且具备安全异常兜底", () => {
    const autoRes = lowlight.highlightAuto("const answer = 42;")
    expect(autoRes.type).toBe("root")
    expect(autoRes.children.length).toBeGreaterThan(0)

    // 即使入参异常或解析异常，也不抛出错误
    expect(() => {
      lowlight.highlightAuto("")
    }).not.toThrow()
  })
})
