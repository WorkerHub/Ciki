import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // workerd 里跑的那组用例有自己的配置（vitest.workers.config.ts）：
    // 它们会断言自己跑在 workerd 里，在 Node 下必然红，这里排除而不是重复跑。
    exclude: ["**/node_modules/**", "test/workers/**"],
    include: ["test/**/*.test.ts"]
  }
})
