/**
 * 存量刷短运维脚本（scripts/repair-agent-emails.mjs）自动化测试：
 * 1. 与 worker/src/db/queries/users.ts 的长式占位邮箱正则同源锁（改一边必须改另一边）
 * 2. 表名与三态前缀解析与 worker/src/lib/tables.ts 的 usersTable 保持一致
 * 3. CLI 参数解析与默认值（默认 binding = DB，默认 worker/wrangler.toml）
 * 4. 执行流程覆盖：--dry-run 预演、严格筛选（kind=agent 且匹配长式占位）、不改 updated_at、幂等性二次执行与残留校验
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  LONG_AGENT_EMAIL_REGEX as MJS_REGEX,
  parseArgs,
  performAgentEmailRepair,
  resolveEffectiveTablePrefix,
  resolveUsersTableName
} from "../../scripts/repair-agent-emails.mjs"
import { resolveForCi } from "../../scripts/resolve-table-prefix.mjs"
import { LONG_AGENT_EMAIL_REGEX as TS_REGEX } from "../src/db/queries/users"
import { getTablePrefix } from "../src/lib/table-prefix"
import { usersTable } from "../src/lib/tables"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

describe("长式 Agent 邮箱正则双向锁", () => {
  it("scripts/repair-agent-emails.mjs 与 worker/src/db/queries/users.ts 正则完全一致", () => {
    expect(MJS_REGEX.source).toBe(TS_REGEX.source)
    expect(MJS_REGEX.flags).toBe(TS_REGEX.flags)
  })

  it("正则严格匹配 lowercase uuid 长式占位邮箱", () => {
    expect(
      MJS_REGEX.test("agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal")
    ).toBe(true)
    // 拒绝大写
    expect(
      MJS_REGEX.test("agent-84E9A354-94B3-4D82-AE1E-6B4A45F78005@internal")
    ).toBe(false)
    // 拒绝短式
    expect(MJS_REGEX.test("Muse@internal")).toBe(false)
    // 拒绝外部域名
    expect(
      MJS_REGEX.test("agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@example.com")
    ).toBe(false)
    // 拒绝非 agent 前缀
    expect(
      MJS_REGEX.test("user-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal")
    ).toBe(false)
  })
})

describe("表名与前缀解析一致性", () => {
  it("与运行时 usersTable(getTablePrefix(...)) 在三态输入下得出相同表名", () => {
    const testCases = [undefined, "", "none", "wiki", "wiki_", "ciki", "ciki_"]
    for (const raw of testCases) {
      const mjsTable = resolveUsersTableName(raw)
      const tsEffectivePrefix = getTablePrefix({
        TABLE_PREFIX: resolveForCi(raw)
      })
      const tsTable = usersTable(tsEffectivePrefix)
      expect(mjsTable).toBe(tsTable)
    }
  })

  it("默认前缀为 ciki_users，none 前缀为 users", () => {
    expect(resolveEffectiveTablePrefix(undefined)).toBe("ciki_")
    expect(resolveEffectiveTablePrefix("none")).toBe("")
    expect(resolveEffectiveTablePrefix("custom")).toBe("custom_")
    expect(resolveUsersTableName(undefined)).toBe("ciki_users")
    expect(resolveUsersTableName("")).toBe("ciki_users")
    expect(resolveUsersTableName("none")).toBe("users")
    expect(resolveUsersTableName("custom")).toBe("custom_users")
  })
})

describe("CLI 参数解析", () => {
  it("默认参数：remote=true, dryRun=false, database='DB', config=worker/wrangler.toml", () => {
    const args = parseArgs([])
    expect(args.isRemote).toBe(true)
    expect(args.isDryRun).toBe(false)
    expect(args.database).toBe("DB")
    expect(args.configPath).toBe(path.resolve(repoRoot, "worker/wrangler.toml"))
    expect(args.prefix).toBe(process.env.TABLE_PREFIX)
  })

  it("支持覆盖各项参数", () => {
    const args = parseArgs([
      "--local",
      "--dry-run",
      "--database",
      "ciki_prod",
      "--config",
      "custom-wrangler.toml",
      "--prefix",
      "none"
    ])
    expect(args.isRemote).toBe(false)
    expect(args.isDryRun).toBe(true)
    expect(args.database).toBe("ciki_prod")
    expect(args.configPath).toBe(path.resolve(repoRoot, "custom-wrangler.toml"))
    expect(args.prefix).toBe("none")
  })

  it("支持 --binding 别名", () => {
    const args = parseArgs(["--binding", "MY_D1_BINDING"])
    expect(args.database).toBe("MY_D1_BINDING")
  })
})

describe("performAgentEmailRepair 执行逻辑与幂等性", () => {
  interface MockUser {
    id: number
    username: string
    email: string
    kind: string
    updated_at: string
  }

  function createMockExecutor(
    initialUsers: MockUser[],
    tableName = "ciki_users"
  ) {
    const users: MockUser[] = JSON.parse(JSON.stringify(initialUsers))
    const tables = [tableName]

    return {
      getUsers: () => users,
      executor: (sql: string) => {
        // 1. 表存在性检查
        if (sql.includes("SELECT name FROM sqlite_master WHERE type='table'")) {
          const match = /name = '([^']+)'/.exec(sql)
          const reqTable = match ? match[1] : ""
          return {
            results: tables
              .filter((t) => t === reqTable)
              .map((name) => ({ name })),
            success: true
          }
        }

        // 2. 扫描 agent 账号
        if (
          sql.startsWith(`SELECT id, username, email, kind FROM ${tableName}`)
        ) {
          const agents = users.filter((u) => u.kind === "agent")
          return {
            results: agents.map((u) => ({
              id: u.id,
              username: u.username,
              email: u.email,
              kind: u.kind
            })),
            success: true
          }
        }

        // 3. 更新语句
        if (sql.startsWith(`UPDATE ${tableName}`)) {
          const emailMatch = /SET email = '([^']+)'/.exec(sql)
          const idMatch = /WHERE id = (\d+)/.exec(sql)
          const oldEmailMatch = /email = '([^']+)'$/.exec(sql)

          if (emailMatch && idMatch && oldEmailMatch) {
            const newEmail = emailMatch[1]
            const targetId = Number(idMatch[1])
            const oldEmail = oldEmailMatch[1]
            const user = users.find(
              (u) =>
                u.id === targetId && u.kind === "agent" && u.email === oldEmail
            )
            if (user) {
              user.email = newEmail
              return { success: true, meta: { changes: 1 } }
            }
          }
          return { success: true, meta: { changes: 0 } }
        }

        throw new Error(`Unhandled SQL: ${sql}`)
      }
    }
  }

  it("目标表不存在时 fail closed 抛出异常", () => {
    const { executor } = createMockExecutor([], "other_table")
    expect(() =>
      performAgentEmailRepair({
        prefix: "ciki",
        executor
      })
    ).toThrow("Table 'ciki_users' does not exist in database 'DB'")
  })

  it("预演模式（--dry-run）：命中正确行数，不执行写入", () => {
    const initialUsers: MockUser[] = [
      {
        id: 1,
        username: "human_user",
        email: "agent-11111111-1111-1111-1111-111111111111@internal",
        kind: "human",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 2,
        username: "target_agent",
        email: "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 3,
        username: "custom_agent",
        email: "custom@example.com",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 4,
        username: "short_agent",
        email: "short_agent@internal",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      }
    ]

    const { getUsers, executor } = createMockExecutor(initialUsers)
    const dryResult = performAgentEmailRepair({
      isDryRun: true,
      prefix: "ciki",
      executor
    })

    expect(dryResult.matchedCount).toBe(1)
    expect(dryResult.updatedCount).toBe(0)
    expect(dryResult.residualCount).toBe(1)

    // 验证无任何数据被改动
    const current = getUsers()
    expect(current[1].email).toBe(
      "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal"
    )
  })

  it("正式执行：仅更新命中 agent 的 email，不改 updated_at，跳过真人与其他 agent，第二遍执行完全幂等", () => {
    const initialUsers: MockUser[] = [
      {
        id: 1,
        username: "human_user",
        email: "agent-11111111-1111-1111-1111-111111111111@internal",
        kind: "human",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 2,
        username: "target_agent",
        email: "agent-84e9a354-94b3-4d82-ae1e-6b4a45f78005@internal",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 3,
        username: "custom_agent",
        email: "custom@example.com",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      },
      {
        id: 4,
        username: "short_agent",
        email: "short_agent@internal",
        kind: "agent",
        updated_at: "2026-01-01T00:00:00Z"
      }
    ]

    const { getUsers, executor } = createMockExecutor(initialUsers)

    // 第一遍执行
    const firstResult = performAgentEmailRepair({
      isDryRun: false,
      prefix: "ciki",
      executor
    })

    expect(firstResult.matchedCount).toBe(1)
    expect(firstResult.updatedCount).toBe(1)
    expect(firstResult.residualCount).toBe(0)

    const current = getUsers()
    // 人类邮箱绝不碰
    expect(current[0].email).toBe(
      "agent-11111111-1111-1111-1111-111111111111@internal"
    )
    // 目标 agent 邮箱更新为 <username>@internal
    expect(current[1].email).toBe("target_agent@internal")
    // updated_at 原封不动保持原值
    expect(current[1].updated_at).toBe("2026-01-01T00:00:00Z")
    // 自定义邮箱 agent 不碰
    expect(current[2].email).toBe("custom@example.com")
    // 既有短式邮箱 agent 不碰
    expect(current[3].email).toBe("short_agent@internal")

    // 第二遍执行验证幂等性（no-op）
    const secondResult = performAgentEmailRepair({
      isDryRun: false,
      prefix: "ciki",
      executor
    })

    expect(secondResult.matchedCount).toBe(0)
    expect(secondResult.updatedCount).toBe(0)
    expect(secondResult.residualCount).toBe(0)
  })
})
