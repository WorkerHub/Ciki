import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const repoRoot = path.resolve(import.meta.dirname, "..")

/** 版本兜底：仓库根 package.json 的 version（与 CI 版本号同源）。 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8")
    const { version } = JSON.parse(raw) as { version?: string }
    return version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/**
 * 构建版本号（规格 §8：页脚/关于页的版本号由 CI 注入，源码里禁写死）。
 * 取 `git describe --tags --always --dirty`；浅克隆或无 git 时返回 null 走兜底。
 */
function readGitDescribe(): string | null {
  try {
    const out = execFileSync(
      "git",
      ["describe", "--tags", "--always", "--dirty"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trim()
    return out || null
  } catch {
    return null
  }
}

/** CI 传入的构建号（github.run_number）；本地缺省。 */
function readBuildNumber(): string | null {
  const raw = process.env.BUILD_NUMBER?.trim()
  return raw && /^\d+$/.test(raw) ? raw : null
}

const buildNumber = readBuildNumber()
const packageVersion = readPackageVersion()
const baseVersion = readGitDescribe() ?? `v${packageVersion}`
const appVersion = buildNumber
  ? `${baseVersion}+build.${buildNumber}`
  : baseVersion

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_PACKAGE_VERSION__: JSON.stringify(packageVersion),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src")
    }
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
})
