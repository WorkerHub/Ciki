/**
 * waker 门的三态判定（规格 §3）：唯一判定处 worker/src/core/waker-gate.ts。
 *
 * 覆盖：未配置（非字符串 / 空 / 空白 / `*_PLACEHOLDER`）、显式关闭（保留值 `false`，
 * 大小写敏感、trim 后命中）、已配置（其余非空串）。关键不变量：`false` 只被判定层
 * 识别，`wakerSigningKey()` 对它返回 `null`，绝不作为验签钥传给 waker SDK。
 */
import { describe, expect, it } from "vitest"
import {
  WAKER_SIGNING_KEY_DISABLED,
  wakerGateState,
  wakerSigningKey
} from "../src/core/waker-gate"

type Case = {
  /** 直接传进 env 的值。 */
  raw: string | undefined
  state: "unconfigured" | "disabled" | "configured"
  /** `wakerSigningKey()` 的期望值。 */
  key: string | null
}

const cases: Case[] = [
  // 显式关闭：只认小写 false，trim 后命中。
  { raw: "false", state: "disabled", key: null },
  { raw: " false ", state: "disabled", key: null },
  { raw: "\tfalse\n", state: "disabled", key: null },
  // 大小写不同 = 按真 key 处理，即已配置态。
  { raw: "False", state: "configured", key: "False" },
  { raw: "FALSE", state: "configured", key: "FALSE" },
  { raw: "false ", state: "disabled", key: null },
  // 非空且不是保留值 → 已配置（原样 trim 后返回）。
  { raw: "real-signing-key", state: "configured", key: "real-signing-key" },
  { raw: "  real-signing-key  ", state: "configured", key: "real-signing-key" },
  { raw: "falsey", state: "configured", key: "falsey" },
  { raw: "0", state: "configured", key: "0" },
  // 未配置：非字符串 / 空 / 空白 / 模板占位值。
  { raw: undefined, state: "unconfigured", key: null },
  { raw: "", state: "unconfigured", key: null },
  { raw: "   ", state: "unconfigured", key: null },
  { raw: "\n\t ", state: "unconfigured", key: null },
  {
    raw: "WAKER_SIGNING_KEY_PLACEHOLDER",
    state: "unconfigured",
    key: null
  },
  { raw: "  SOMETHING_PLACEHOLDER  ", state: "unconfigured", key: null }
]

describe("waker 门：三态判定", () => {
  for (const { raw, state, key } of cases) {
    const label = raw === undefined ? "undefined" : JSON.stringify(raw)
    it(`${label} → ${state}`, () => {
      const env = { WAKER_SIGNING_KEY: raw }
      expect(wakerGateState(env)).toBe(state)
      expect(wakerSigningKey(env)).toBe(key)
    })
  }

  it("非字符串一律按未配置处理（Secret 未注入时的防御）", () => {
    const env = { WAKER_SIGNING_KEY: 0 as unknown as string }
    expect(wakerGateState(env)).toBe("unconfigured")
    expect(wakerSigningKey(env)).toBeNull()
  })

  it("保留值是字面量 false：改动它必须同步部署脚本的口径", () => {
    expect(WAKER_SIGNING_KEY_DISABLED).toBe("false")
  })
})

describe("waker 门：false 绝不进验签钥", () => {
  it("显式关闭态下 wakerSigningKey() 为 null（SDK 据此 fail closed）", () => {
    for (const raw of ["false", " false ", "  false  "]) {
      expect(wakerSigningKey({ WAKER_SIGNING_KEY: raw })).toBeNull()
    }
  })
})
