// jsdom 环境的测试公共准备：jest-dom 断言 + 每个用例后清理 DOM。
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

afterEach(() => {
  cleanup()
})
