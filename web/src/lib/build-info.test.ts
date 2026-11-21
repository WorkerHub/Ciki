import { execFileSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildInfo, buildVersionLabel, versionSegments } from "@/lib/build-info"

const repoRoot = path.resolve(process.cwd(), "..")

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
  } catch {
    return null
  }
}

/** 独立算一遍 git describe 的展示形态，和生成脚本比对（证明没有写死）。 */
function expectedVersion(): string {
  const described = git(["describe", "--tags", "--long"])
  if (described) {
    const matched = described.match(/^(.+)-(\d+)-g([0-9a-f]+)$/)
    if (matched) return `${matched[1]}-${matched[2]}-${matched[3]}`
  }
  const hash = git(["rev-parse", "--short", "HEAD"])
  if (!hash) return "v1.0.0-0-unknown"
  const count = git(["rev-list", "--count", "HEAD"]) ?? "0"
  return `v1.0.0-${count}-${hash}`
}

describe("构建信息", () => {
  it("版本号来自 git describe（不是写死值）", () => {
    expect(buildInfo.version).toBe(expectedVersion())
  })

  it("版本号符合 v<semver>-<提交数>-<短哈希> 格式", () => {
    expect(buildInfo.version).toMatch(
      /^v\d+\.\d+\.\d+-\d+-([0-9a-f]{7,}|unknown)$/
    )
    expect(buildInfo.commitCount).toBeGreaterThanOrEqual(0)
  })

  it("版本号拆成三段式 semver/commitCount/commit", () => {
    const segments = versionSegments()
    expect(segments).not.toBeNull()
    expect(segments!.semver).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Number.isInteger(segments!.commitCount)).toBe(true)
    expect(segments!.commit).toMatch(/^[0-9a-f]{7,}$|^unknown$/)
    expect(
      `${segments!.semver}-${segments!.commitCount}-${segments!.commit}`
    ).toBe(buildInfo.version.replace(/^v/, ""))
  })

  it("版本标签带站名时是「站名 · semver · 短哈希+build.提交数」", () => {
    const segments = versionSegments()
    expect(segments).not.toBeNull()
    expect(buildVersionLabel("Ciki")).toBe(
      `Ciki · ${segments!.semver} · ${segments!.commit}+build.${segments!.commitCount}`
    )
    expect(buildVersionLabel()).toBe(
      `${segments!.semver} · ${segments!.commit}+build.${segments!.commitCount}`
    )
  })
})
