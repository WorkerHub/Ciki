/**
 * 构建信息（规格 §6.3）：值由 scripts/build-info.mjs 在构建前从 git 生成，
 * 源码里没有任何写死的版本号/日期。
 *
 * 侧栏页脚只读这里的 `buildVersionLabel`，保证与生成脚本（以及 Worker 的
 * `/api/public` 版本自证）同一份值、同一套 `v<semver>-<提交数>-<短哈希>` 格式。
 */
import raw from "../../../build-info.json"

export interface BuildInfo {
  /** v<semver>-<提交数>-<短哈希>，如 v1.3.0-8-479967d */
  version: string
  commit: string
  commitCount: number
  /** ISO 时间（构建时刻） */
  builtAt: string
  timeZone: string
  /** +08:00 / -05:00 之类的 UTC 偏移 */
  offset: string
}

export const buildInfo = raw as BuildInfo

/**
 * 把 `buildInfo.version`（`v<semver>-<提交数>-<短哈希>`）拆成三段式所需的
 * `{ semver, commitCount, commit }`。解析失败返回 `null`，调用方回落整串版本号。
 */
export function versionSegments(): {
  semver: string
  commitCount: number
  commit: string
} | null {
  const parts = buildInfo.version.split("-")
  if (parts.length < 3) return null
  const semver = /^v?\d+\.\d+\.\d+/.exec(parts[0])?.[0].replace(/^v/, "")
  const commitCount = Number(parts[parts.length - 2])
  const commit = parts[parts.length - 1]
  if (!semver || !Number.isInteger(commitCount)) return null
  return { semver, commitCount, commit }
}

/** 侧栏/页脚展示用：`站名 · <semver> · <短哈希>+build.<提交数>`，无站名只给版本。 */
export function buildVersionLabel(name?: string): string {
  const segments = versionSegments()
  const version = segments
    ? `${segments.semver} · ${segments.commit}+build.${segments.commitCount}`
    : buildInfo.version
  return name ? `${name} · ${version}` : version
}
