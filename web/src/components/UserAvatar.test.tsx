import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { UserAvatar } from "@/components/UserAvatar"

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
