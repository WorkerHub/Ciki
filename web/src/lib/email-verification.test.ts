import { describe, expect, it } from "vitest"
import { verifyEmailEntry } from "@/lib/email-verification"

/**
 * 验证页入口状态的归一规则：路由 state 优先于 `?email=`，
 * 其余两个标记只在明确为 true 时生效（不把字符串 "false" 当 true）。
 */
describe("verifyEmailEntry", () => {
  it("注册页带来的状态：邮箱、已发码、待审批三个标记都认", () => {
    expect(
      verifyEmailEntry(
        { email: " a@b.c ", codeSent: true, approvalRequired: true },
        null
      )
    ).toEqual({ email: "a@b.c", codeSent: true, approvalRequired: true })
  })

  it("直接开链接时读 ?email=，不会平白锁住重发冷却", () => {
    expect(verifyEmailEntry(null, " c@d.e ")).toEqual({
      email: "c@d.e",
      codeSent: false,
      approvalRequired: false
    })
  })

  it("state 与 query 同时存在时以 state 为准", () => {
    expect(verifyEmailEntry({ email: "state@b.c" }, "query@b.c").email).toBe(
      "state@b.c"
    )
  })

  it("两个来源都没有邮箱时留空，交给输入框", () => {
    expect(verifyEmailEntry(undefined, null)).toEqual({
      email: "",
      codeSent: false,
      approvalRequired: false
    })
  })

  it("非布尔的标记不被当成 true", () => {
    expect(
      verifyEmailEntry({ email: "a@b.c", codeSent: "yes" }, null)
    ).toMatchObject({ codeSent: false, approvalRequired: false })
  })
})
