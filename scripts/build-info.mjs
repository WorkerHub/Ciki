/**
 * 构建信息（规格 §6.3）：构建时从 git 生成，禁止在源码里写死。
 *
 * 产物是仓库根的 `build-info.json`（已 gitignore），由 web 与 worker 各自导入，
 * 同一次构建里两边拿到同一份值：
 *   { version, commit, commitCount, builtAt, timeZone, offset }
 *
 * 版本号格式（技术方案 §5A.2）：
 *   v<semver>-<该标签之后的提交数>-<短哈希>   例：v1.3.0-8-479967d
 * 无 tag 时 v1.0.0-<提交数>-<短哈希> 兜底；完全没有 git信息时 v1.0.0-0-unknown。
 * `git describe` 原始输出的第三段带 `g` 前缀，这里去掉。
 *
 * 何时跑：根与 web/worker 的 predev/prebuild/pretypecheck/pretest 钩子；
 * 部署时 deploy.yml 用 `node scripts/build-info.mjs --print` 取同一个版本号，
 * 经 `wrangler deploy --var APP_VERSION=…` 交给 Worker 的 /api/public（§6.3）。
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
  } catch {
    return null
  }
}

function shortHash() {
  return git(["rev-parse", "--short", "HEAD"])
}

function commitCount() {
  const value = git(["rev-list", "--count", "HEAD"])
  return value ? Number.parseInt(value, 10) : 0
}

function resolveVersion() {
  // 有 tag：v1.2.3-4-gabc1234 → v1.2.3-4-abc1234（去掉 describe 的 g 前缀）
  const described = git(["describe", "--tags", "--long"])
  if (described) {
    const matched = described.match(/^(.+)-(\d+)-g([0-9a-f]+)$/)
    if (matched) {
      return {
        version: `${matched[1]}-${matched[2]}-${matched[3]}`,
        commit: matched[3],
        commitCount: Number.parseInt(matched[2], 10)
      }
    }
  }

  const hash = shortHash()
  if (!hash) {
    return { version: "v1.0.0-0-unknown", commit: "unknown", commitCount: 0 }
  }
  const count = commitCount()
  return {
    version: `v1.0.0-${count}-${hash}`,
    commit: hash,
    commitCount: count
  }
}

function formatOffset(date) {
  // getTimezoneOffset 是 UTC 减本地的分钟数，符号与 ISO 的 +08:00 相反。
  const total = -date.getTimezoneOffset()
  const sign = total < 0 ? "-" : "+"
  const abs = Math.abs(total)
  const hours = String(Math.floor(abs / 60)).padStart(2, "0")
  const minutes = String(abs % 60).padStart(2, "0")
  return `${sign}${hours}:${minutes}`
}

// `--print`：只把版本号写到 stdout（CI 注入 Worker 变量用），不打印日志行。
// 产物照旧落盘——单一代码路径，调用方不必关心文件与输出的取舍。
const printOnly = process.argv.includes("--print")

const now = new Date()
const resolved = resolveVersion()

const buildInfo = {
  version: resolved.version,
  commit: resolved.commit,
  commitCount: resolved.commitCount,
  builtAt: now.toISOString(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offset: formatOffset(now)
}

writeFileSync(
  path.join(root, "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`
)

if (printOnly) {
  process.stdout.write(`${buildInfo.version}\n`)
} else {
  console.log(
    `build-info: ${buildInfo.version} · ${buildInfo.builtAt} (${buildInfo.timeZone} UTC${buildInfo.offset})`
  )
}
