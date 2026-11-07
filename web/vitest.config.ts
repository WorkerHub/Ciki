import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

// 测试环境同样注入构建期常量（与 web/vite.config.ts 的 define 一一对应），
// 否则源码里引用 __APP_VERSION__ / __APP_BUILD_TIME__ 会在用例里变成未定义变量。
const TEST_APP_VERSION = "test-build"
const TEST_APP_BUILD_TIME = "2026-01-01T00:00:00.000Z"

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(TEST_APP_VERSION),
    __APP_BUILD_TIME__: JSON.stringify(TEST_APP_BUILD_TIME)
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"]
  }
})
