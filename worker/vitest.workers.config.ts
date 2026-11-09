/**
 * 在 workerd 里跑的测试（`@cloudflare/vitest-plugin`，底层 Miniflare + 本机 workerd）。
 *
 * 与 `vitest.config.ts`（Node 环境）并存、互不影响：Node 那套照旧跑既有全部用例，
 * 这里只跑 `test/workers/**`——会在 Workers 打包/运行时下表现不同的那条路径
 * （导入渲染：TipTap JSON → HTML → 消毒）。背景见 #32：Node 下全绿、线上仍然炸。
 *
 * 兼容性日期与标志不在这里另写一份：直接读 `wrangler.toml`，保证测试运行时与线上
 * Worker 是同一套。读不到就立刻抛错（宁可红，也不要静默跑在错误的兼容面上）。
 * 刻意不用 `wrangler.configPath`：那份配置带 `[assets] ../web/dist`、D1/R2 绑定与
 * crons，会要求先构建前端、并把整个 Worker 一起打包，和「只测渲染路径」无关。
 *
 * `remoteBindings: false` 是红线钉子：这组用例不挂任何绑定，即使将来挂了也只走本地。
 *
 * 两处必要的修补，都是**测试宿主的缺口**而非线上差异：
 * - `node:vm`：插件给它所载入的模块注入自己那份只含 `runInThisContext` 的替身，
 *   而线上 workerd 的 `node:vm` 是完整的。happy-dom 在模块求值时就 `new Script(...)`，
 *   没有这个构造器整条渲染路径连加载都起不来，所以这里换成本地替身
 *   （见 test/workers/node-vm-shim.ts）。
 * - `xss`：纯 CJS 包，默认导出拿得到、具名导出（`FilterXSS` / `escapeAttrValue`）
 *   拿不到，需要用 Vitest 的 SSR 依赖预打包补上具名导出。
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

/** 从 wrangler.toml 取运行时兼容性设置（与线上同一份，不复制第二份）。 */
function wranglerRuntime(): {
  compatibilityDate: string
  compatibilityFlags: string[]
} {
  const toml = readFileSync(
    path.resolve(import.meta.dirname, "wrangler.toml"),
    "utf8"
  )
  const date = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml)?.[1]
  const rawFlags = /^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1]
  if (!date || rawFlags === undefined) {
    throw new Error(
      "vitest.workers.config.ts: wrangler.toml 里找不到 compatibility_date / compatibility_flags"
    )
  }
  const compatibilityFlags = [...rawFlags.matchAll(/"([^"]*)"/g)].map(
    (match) => match[1]
  )
  return { compatibilityDate: date, compatibilityFlags }
}

const vmShim = path.resolve(import.meta.dirname, "test/workers/node-vm-shim.ts")

export default defineConfig({
  plugins: [
    cloudflareTest({ miniflare: wranglerRuntime(), remoteBindings: false })
  ],
  resolve: {
    // 见文件头：插件注入的 node:vm 替身让 happy-dom 连加载都过不去。
    alias: { "node:vm": vmShim, vm: vmShim }
  },
  test: {
    include: ["test/workers/**/*.test.ts"],
    // xss 是纯 CJS，具名导出要靠预打包补全（见文件头）。
    deps: { optimizer: { ssr: { enabled: true, include: ["xss"] } } }
  }
})
