/**
 * waker 回调入口（规格 §3）：验签、防重放、缺 key fail closed、executionId 幂等
 * 与让路。签名材料、规范串与错误码都按 SDK 的冻结契约来，测试里用同一份规范串自签。
 */
import { describe, expect, it } from "vitest"
import { R2_CLEANUP_JOB_NAME } from "../src/core/r2-cleanup"
import { CLEANUP_LOCK_KEY } from "../src/db/queries/r2-cleanup"
import { initializedContext, request } from "./support/app"

const SIGNING_KEY = "unit-test-signing-key"

type Env = Awaited<ReturnType<typeof initializedContext>>["env"]
type Db = Awaited<ReturnType<typeof initializedContext>>["db"]

async function sign(
  key: string,
  timestamp: string,
  executionId: string,
  jobId: string,
  body: string
): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(`${timestamp}\n${executionId}\n${jobId}\n${body}`)
  )
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `v2=${hex}`
}

function callbackBody(overrides: Record<string, unknown> = {}): string {
  const now = Date.now()
  return JSON.stringify({
    protocolVersion: 2,
    executionId: "exec-1",
    jobId: "job-1",
    projectId: "ciki",
    jobName: R2_CLEANUP_JOB_NAME,
    kind: "cron",
    trigger: "schedule",
    misfire: false,
    attempt: 0,
    scheduledFor: now,
    dispatchedAt: now,
    timeoutSeconds: 30,
    payload: null,
    ...overrides
  })
}

interface SendOptions {
  body?: string
  timestampSeconds?: number
  executionId?: string
  jobId?: string
  /** 覆盖签名（用于「错签」用例）。 */
  signature?: string
  /** 是否省略全部签名头。 */
  omitHeaders?: boolean
}

async function send(
  env: Env,
  options: SendOptions = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = options.body ?? callbackBody()
  const parsed = JSON.parse(body) as { executionId: string; jobId: string }
  const executionId = options.executionId ?? parsed.executionId
  const jobId = options.jobId ?? parsed.jobId
  const timestamp = String(
    options.timestampSeconds ?? Math.floor(Date.now() / 1000)
  )

  const headers: Record<string, string> = {
    "content-type": "application/json"
  }
  if (!options.omitHeaders) {
    headers["x-waker-timestamp"] = timestamp
    headers["x-waker-execution-id"] = executionId
    headers["x-waker-job-id"] = jobId
    headers["x-waker-signature"] =
      options.signature ??
      (await sign(SIGNING_KEY, timestamp, executionId, jobId, body))
  }

  const res = await request(env, "/_waker/execute", {
    method: "POST",
    headers,
    body
  })
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>
  }
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? ""
}

function countRuns(db: Db): number {
  const row = db.db
    .prepare("SELECT COUNT(*) AS count FROM ciki_r2_cleanup_runs")
    .get() as { count: number }
  return row.count
}

describe("waker 回调：缺 key fail closed", () => {
  it("没配 WAKER_SIGNING_KEY → 500 signing_key_missing，且不落任何日志行", async () => {
    const { env, db } = await initializedContext()
    const res = await send(env)
    expect(res.status).toBe(500)
    expect(errorCode(res.body)).toBe("signing_key_missing")
    expect(countRuns(db)).toBe(0)
  })

  it("WAKER_SIGNING_KEY=false（显式关闭）→ 同样 fail closed：receiver 拿到 null 钥", async () => {
    const { env, db, r2 } = await initializedContext({
      WAKER_SIGNING_KEY: "false"
    })
    // 即便 waker 侧真的拿 "false" 当钥签名也永远验不过：receiver 拿到的钥在验签前就已是 null。
    const res = await send(env)

    expect(res.status).toBe(500)
    expect(errorCode(res.body)).toBe("signing_key_missing")
    expect(countRuns(db)).toBe(0)
    expect(r2.store.size).toBe(0)
  })
})

describe("waker 回调：验签与防重放", () => {
  it("签名正确 → 200，跑一轮清理并落 waker 日志行", async () => {
    const { env, db, r2 } = await initializedContext({
      WAKER_SIGNING_KEY: SIGNING_KEY
    })
    await r2.putWithUploaded(
      "orphan.png",
      new Uint8Array([1]),
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    )

    const res = await send(env)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.trigger).toBe("waker")
    expect(r2.store.has("orphan.png")).toBe(false)

    // 同一次回调把两个桶各跑一轮：两行日志，各带自己的 kind。
    const rows = db.db
      .prepare(
        "SELECT kind, trigger, status, deleted FROM ciki_r2_cleanup_runs ORDER BY kind"
      )
      .all() as Array<{
      kind: string
      trigger: string
      status: string
      deleted: number
    }>
    expect(rows).toEqual([
      { kind: "content", trigger: "waker", status: "ok", deleted: 0 },
      { kind: "images", trigger: "waker", status: "ok", deleted: 1 }
    ])
  })

  it("缺签名头 → 400 invalid_request", async () => {
    const { env } = await initializedContext({ WAKER_SIGNING_KEY: SIGNING_KEY })
    const res = await send(env, { omitHeaders: true })
    expect(res.status).toBe(400)
    expect(errorCode(res.body)).toBe("invalid_request")
  })

  it("签名不对 → 401 invalid_signature", async () => {
    const { env } = await initializedContext({ WAKER_SIGNING_KEY: SIGNING_KEY })
    const res = await send(env, {
      signature: `v2=${"0".repeat(64)}`
    })
    expect(res.status).toBe(401)
    expect(errorCode(res.body)).toBe("invalid_signature")
  })

  it("时间戳超出 300s 窗口 → 401 stale_timestamp（防重放）", async () => {
    const { env } = await initializedContext({ WAKER_SIGNING_KEY: SIGNING_KEY })
    const res = await send(env, {
      timestampSeconds: Math.floor(Date.now() / 1000) - 400
    })
    expect(res.status).toBe(401)
    expect(errorCode(res.body)).toBe("stale_timestamp")
  })

  it("未声明的任务名 → 404 unknown_job", async () => {
    const { env } = await initializedContext({ WAKER_SIGNING_KEY: SIGNING_KEY })
    const res = await send(env, {
      body: callbackBody({ jobName: "someone-elses-job" })
    })
    expect(res.status).toBe(404)
    expect(errorCode(res.body)).toBe("unknown_job")
  })

  it("同一 executionId 重放 → 200 duplicate，不再跑第二轮", async () => {
    const { env, db } = await initializedContext({
      WAKER_SIGNING_KEY: SIGNING_KEY
    })
    const first = await send(env)
    expect(first.status).toBe(200)
    expect(countRuns(db)).toBe(2)

    const second = await send(env)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(countRuns(db)).toBe(2)
  })
})

describe("waker 回调：撞上另一轮清理的锁", () => {
  it("同类另一轮持锁 → 那一类跳过，另一类照跑（只写它自己的日志行）", async () => {
    const { env, db, r2 } = await initializedContext({
      WAKER_SIGNING_KEY: SIGNING_KEY
    })
    await r2.putWithUploaded(
      "orphan.png",
      new Uint8Array([1]),
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    )
    // 管理员正在手动实跑：锁行未过期。
    db.db
      .prepare(
        `INSERT INTO ciki_system_settings (key, value, updated_at)
         VALUES (?, ?, ?)`
      )
      .run(
        `${CLEANUP_LOCK_KEY}:images`,
        JSON.stringify({
          token: "manual-holder",
          startedAt: new Date().toISOString(),
          trigger: "manual",
          dryRun: false
        }),
        new Date().toISOString()
      )

    const res = await send(env)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.skipped).toBe(true)
    expect(res.body.reason).toBe("cleanup_in_progress")
    // 图片那一类被占着不跑；内容桶没有锁，照跑一轮。
    expect(countRuns(db)).toBe(1)
    expect(r2.store.has("orphan.png")).toBe(true)

    // 交给平台的响应体同样带 skipped（平台按 2xx 判成功，不会重试）。
    const ledger = db.db
      .prepare(
        "SELECT response_json FROM ciki_waker_executions WHERE execution_id = 'exec-1'"
      )
      .get() as { response_json: string }
    expect(JSON.parse(ledger.response_json)).toMatchObject({ skipped: true })
  })
})
