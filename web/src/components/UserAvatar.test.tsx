import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { UserAvatar, displayUsername } from "@/components/UserAvatar"
import { i18n } from "@/i18n"

describe("UserAvatar", () => {
  it("首字母圆按码点取首字符，Emoji 不会被截成半个代理对", () => {
    render(
      <UserAvatar
        user={{
          username: "🚀 值班同学",
          email: "duty@example.com",
          avatarUrl: null
        }}
      />
    )

    expect(screen.getByText("🚀")).toBeInTheDocument()
  })
})

describe("显示名的兜底", () => {
  it("用户名与邮箱都没有时，兜底名跟随界面语言", async () => {
    const empty = { username: "", email: "", avatarUrl: null }
    expect(displayUsername(empty)).toBe("用户")

    await i18n.changeLanguage("en")
    expect(displayUsername(empty)).toBe("User")
  })
})
