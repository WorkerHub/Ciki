import { beforeEach, describe, expect, it } from "vitest"
import i18n from "@/i18n"
import { formatAgentAuthor } from "@/lib/agent-display"

describe("formatAgentAuthor", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN")
  })

  it("当为 Agent 且 ownerName 存在时，返回「{agent}（{owner} 的 Agent）」且隐藏 badge", () => {
    const res = formatAgentAuthor({
      name: "deploy-bot",
      isAgent: true,
      ownerName: "Alice"
    })
    expect(res.displayName).toBe("deploy-bot（Alice 的 Agent）")
    expect(res.showAgentBadge).toBe(false)
  })

  it("当为 Agent 但 ownerName 为 null 时，回退展示原名并展示 badge", () => {
    const res = formatAgentAuthor({
      name: "deploy-bot",
      isAgent: true,
      ownerName: null
    })
    expect(res.displayName).toBe("deploy-bot")
    expect(res.showAgentBadge).toBe(true)
  })

  it("当为 Agent 但 ownerName 为全空格时，同样回退", () => {
    const res = formatAgentAuthor({
      name: "deploy-bot",
      isAgent: true,
      ownerName: "   "
    })
    expect(res.displayName).toBe("deploy-bot")
    expect(res.showAgentBadge).toBe(true)
  })

  it("当不是 Agent 时，即使传入 ownerName 也不显示为 Agent", () => {
    const res = formatAgentAuthor({
      name: "Bob",
      isAgent: false,
      ownerName: "Alice"
    })
    expect(res.displayName).toBe("Bob")
    expect(res.showAgentBadge).toBe(false)
  })

  it("英文环境下返回「{agent} ({owner}'s Agent)」", async () => {
    await i18n.changeLanguage("en")
    const res = formatAgentAuthor({
      name: "deploy-bot",
      isAgent: true,
      ownerName: "Alice"
    })
    expect(res.displayName).toBe("deploy-bot (Alice's Agent)")
    expect(res.showAgentBadge).toBe(false)
  })
})
