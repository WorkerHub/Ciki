/**
 * 一次性数据修复脚本：Agent 占位邮箱存量刷短（Task #109）
 *
 * 规格与约束：
 * - 对象：仅 kind = 'agent' 且 email 严格匹配 `agent-<36位uuid>@internal` 的行；
 *   真人邮箱与任何非该形态的值一律不碰。
 * - 动作：逐行把 email 更新为 `<该行 username>@internal`（不碰 updated_at 等无关字段）。
 * - 幂等：可重复执行、第二遍为 no-op。
 * - 报数：执行前先报命中行数、执行后复查长式占位残留为 0 并回报实际更新行数。
 * - 表名与库名：按 §6/§7 规范由配置与三态前缀推导，默认 binding 为 "DB"，配置文件指向 wrangler.toml。
 *
 * 用法：
 *   node scripts/repair-agent-emails.mjs [--remote | --local] [--dry-run] [--binding DB] [--config worker/wrangler.toml] [--prefix ciki]
 */

import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveForCi } from "./resolve-table-prefix.mjs"

export const LONG_AGENT_EMAIL_REGEX =
  /^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@internal$/

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const WRANGLER_BIN = path.resolve(ROOT, "worker/node_modules/.bin/wrangler")

/**
 * 把配置项/环境变量中的原始 TABLE_PREFIX 规范化为运行时生效前缀（与 src/lib/table-prefix.ts 一致）。
 */
export function resolveEffectiveTablePrefix(raw) {
  const resolved = resolveForCi(raw)
  if (resolved === "") {
    return ""
  }
  return resolved.endsWith("_") ? resolved : `${resolved}_`
}

/**
 * 拼装用户表名（与 src/lib/tables.ts usersTable 一致）。
 */
export function resolveUsersTableName(rawPrefix) {
  const prefix = resolveEffectiveTablePrefix(rawPrefix)
  return `${prefix}users`
}

export function parseArgs(rawArgs = process.argv.slice(2)) {
  const isRemote = rawArgs.includes("--remote") || !rawArgs.includes("--local")
  const isDryRun = rawArgs.includes("--dry-run")
  let database = "DB"
  const dbIndex = rawArgs.indexOf("--database")
  if (dbIndex !== -1 && rawArgs[dbIndex + 1]) {
    database = rawArgs[dbIndex + 1]
  }
  const bindingIndex = rawArgs.indexOf("--binding")
  if (bindingIndex !== -1 && rawArgs[bindingIndex + 1]) {
    database = rawArgs[bindingIndex + 1]
  }
  let configPath = path.resolve(ROOT, "worker/wrangler.toml")
  const configIndex = rawArgs.indexOf("--config")
  if (configIndex !== -1 && rawArgs[configIndex + 1]) {
    configPath = path.resolve(ROOT, rawArgs[configIndex + 1])
  }
  let prefix = process.env.TABLE_PREFIX
  const prefixIndex = rawArgs.indexOf("--prefix")
  if (prefixIndex !== -1 && rawArgs[prefixIndex + 1]) {
    prefix = rawArgs[prefixIndex + 1]
  }
  return { isRemote, isDryRun, database, configPath, prefix }
}

export function runWranglerSql(database, isRemote, configPath, sql) {
  const params = [
    "d1",
    "execute",
    database,
    "--command",
    sql,
    "--json",
    "--config",
    configPath
  ]
  if (isRemote) {
    params.splice(3, 0, "--remote")
  }

  const raw = execFileSync(WRANGLER_BIN, params, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"]
  })

  // 过滤 wrangler 的非 JSON 警告信息（如代理环境变量提示）
  const jsonStart = raw.indexOf("[")
  if (jsonStart === -1) {
    throw new Error(`Wrangler output did not contain JSON array: ${raw}`)
  }
  const parsed = JSON.parse(raw.slice(jsonStart))
  return parsed[0]
}

export function performAgentEmailRepair(options = {}) {
  const {
    database = "DB",
    isRemote = true,
    isDryRun = false,
    configPath = path.resolve(ROOT, "worker/wrangler.toml"),
    prefix = process.env.TABLE_PREFIX,
    executor = (sql) => runWranglerSql(database, isRemote, configPath, sql)
  } = options

  const tableName = resolveUsersTableName(prefix)

  // 校验目标表在数据库中是否存在（fail closed）
  const checkSql = `SELECT name FROM sqlite_master WHERE type='table' AND name = '${tableName}'`
  const checkRes = executor(checkSql)
  const names = (checkRes.results ?? []).map((r) => r.name)
  if (!names.includes(tableName)) {
    throw new Error(
      `Table '${tableName}' does not exist in database '${database}'`
    )
  }

  console.log(
    `[Target] 目标数据库/绑定: ${database} (${isRemote ? "remote" : "local"}), 配置文件: ${configPath}, 表名: ${tableName}`
  )

  // 1. 扫描所有 agent 账号
  const scanSql = `SELECT id, username, email, kind FROM ${tableName} WHERE kind = 'agent'`
  const scanRes = executor(scanSql)
  const allAgents = scanRes.results ?? []
  console.log(`[Scan] 数据库中共找到 ${allAgents.length} 个 kind='agent' 账号`)

  // 严格正则过滤
  const targets = allAgents.filter(
    (u) => u.email && LONG_AGENT_EMAIL_REGEX.test(u.email)
  )
  console.log(
    `[Pre-check] 执行前命中长式占位邮箱（agent-<36位uuid>@internal）的目标行数: ${targets.length}`
  )

  for (const target of targets) {
    console.log(
      `  - 命中 ID: ${target.id}, 用户名: ${target.username}, 当前邮箱: ${target.email} -> 目标邮箱: ${target.username}@internal`
    )
  }

  if (targets.length === 0) {
    console.log("[Pre-check] 没有需要修复的长式占位邮箱。")
  }

  if (isDryRun) {
    console.log("[Dry Run] 处于预演模式，不写入数据库。")
    return {
      matchedCount: targets.length,
      updatedCount: 0,
      residualCount: targets.length
    }
  }

  let updatedCount = 0
  if (targets.length > 0) {
    for (const target of targets) {
      const newEmail = `${target.username}@internal`
      // 转义单引号以安全拼入 SQL
      const escapedNewEmail = newEmail.replace(/'/g, "''")
      const escapedOldEmail = target.email.replace(/'/g, "''")
      const updateSql = `UPDATE ${tableName} SET email = '${escapedNewEmail}' WHERE id = ${target.id} AND kind = 'agent' AND email = '${escapedOldEmail}'`
      const updateRes = executor(updateSql)
      let changes = updateRes.meta?.changes
      if (changes === undefined) {
        changes = updateRes.success ? 1 : 0
      }
      updatedCount += changes
      console.log(`  - 已更新 ID: ${target.id} (changes: ${changes})`)
    }
  }

  console.log(`[Execution] 实际更新行数: ${updatedCount}`)

  // 2. 复查残留
  const postScanRes = executor(scanSql)
  const postAgents = postScanRes.results ?? []
  const residualTargets = postAgents.filter(
    (u) => u.email && LONG_AGENT_EMAIL_REGEX.test(u.email)
  )
  const residualCount = residualTargets.length
  console.log(`[Post-check] 执行后复查长式占位残留数: ${residualCount}`)

  if (residualCount !== 0) {
    throw new Error(
      `Residual check failed: ${residualCount} long-form placeholder emails remain!`
    )
  }

  return {
    matchedCount: targets.length,
    updatedCount,
    residualCount
  }
}

// 主入口运行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs()
  console.log("=== Agent 占位邮箱存量刷短：一次性数据修复 ===")
  const firstRun = performAgentEmailRepair(args)
  console.log(
    `[Summary] 首次执行结果: 命中 ${firstRun.matchedCount} 行, 更新 ${firstRun.updatedCount} 行, 残留 ${firstRun.residualCount} 行`
  )

  if (!args.isDryRun) {
    console.log("\n=== 幂等性复核（第二遍执行）===")
    const secondRun = performAgentEmailRepair({ ...args, isDryRun: false })
    console.log(
      `[Idempotency] 第二遍执行结果: 命中 ${secondRun.matchedCount} 行, 更新 ${secondRun.updatedCount} 行, 残留 ${secondRun.residualCount} 行 (no-op 验证成功)`
    )
  }
}
