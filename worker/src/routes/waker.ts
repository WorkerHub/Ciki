/**
 * `/_waker` 回调入口：把请求交给 waker 客户端 SDK 的 receiver。
 *
 * 挂在 `index.ts` 里、SPA 回落 `app.get("*")` **之前**，否则回调会被回落成 200
 * HTML。路径、验签、防重放、executionId 幂等与错误码全部由 SDK 决定，本文件不
 * 复制协议、也不自行发明一套（规格 §3：按 eNotify 现行 waker 回调契约同口径）。
 *
 * 为什么按请求构造：`env`（signing key 与 D1 绑定、表前缀）只在请求期可见，而
 * receiver 要从 env 取 key 与 `{prefix}waker_executions` 账本表。构造只是建对象、
 * 不做任何 IO。缺 key 时 receiver 自己 fail closed（500 `signing_key_missing`），
 * 不碰库、不进业务。
 */
import { Hono } from "hono"
import { R2_CLEANUP_JOB_NAME, runAllBucketCleanups } from "../core/r2-cleanup"
import { wakerSigningKey } from "../core/waker-gate"
import { getTablePrefix } from "../lib/table-prefix"
import { wakerExecutionsTable } from "../lib/tables"
import type { Env, HonoEnv } from "../types"
import {
  CALLBACK_MOUNT_PATH,
  createD1ExecutionLedger,
  createWakerReceiver
} from "../waker"

function createCleanupReceiver(env: Env) {
  const prefix = getTablePrefix(env)
  return createWakerReceiver({
    jobs: {
      // 同步语义：handler await 到整轮跑完才返回，SDK 之后才回 2xx；抛错则由
      // SDK 释放幂等占位并回 5xx，平台按同一 executionId 重试。
      [R2_CLEANUP_JOB_NAME]: async () => {
        // 同一个任务名跑两类清理（先图片、后内容）：waker 侧注册不用改。
        // 某一类被别的入口占着锁只跳过那一类（抢到锁那轮已经把同样的活干完了），
        // 不写日志行、也不算失败，避免平台按 executionId 反复重试。
        const outcomes = await runAllBucketCleanups(env, {
          trigger: "waker",
          dryRun: false,
          rerunGuard: "enforce"
        })
        console.info("waker callback r2 cleanup runs:", outcomes)
        const busy = outcomes.filter((outcome) => outcome.status === "busy")
        // 两类都被别的入口占着：这一轮什么也没做，按成功返回（平台不重试）。
        if (busy.length === outcomes.length) {
          return {
            ok: true,
            skipped: true,
            reason: "cleanup_in_progress"
          }
        }
        return {
          ok: true,
          trigger: "waker",
          skipped: busy.length > 0,
          reason: busy.length > 0 ? "cleanup_in_progress" : undefined,
          runs: outcomes
        }
      }
    },
    // 判定与验签同源（三态）：只有已配置态给出钥，未配置与关闭（`false`）一律 null，
    // 即 SDK 的 fail closed 路径。
    signingKey: () => wakerSigningKey(env),
    ledger: createD1ExecutionLedger(env.DB, {
      table: wakerExecutionsTable(prefix)
    }),
    onJobError: (error, context) => {
      // 只打任务标识与错误信息：不打印载荷、请求头或密钥。
      console.error(
        `waker job ${context.jobName} (execution ${context.executionId}, attempt ${context.attempt}) failed:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  })
}

/**
 * receiver 的路由表是相对挂载前缀的（`POST /execute`），必须经
 * `app.route(前缀, receiver)` 才会命中——这里用临时 Hono 宿主按 SDK 的挂载方式
 * 接上（路径剥离与未声明路径的 404 都由 Hono + SDK 决定，不手写转发逻辑）。
 */
function forwardToReceiver(
  request: Request,
  env: Env
): Response | Promise<Response> {
  const host = new Hono<HonoEnv>()
  host.onError((err, c) => {
    console.error(
      "Unhandled error in waker receiver:",
      err instanceof Error ? err.message : String(err)
    )
    return c.json({ error: "Internal server error" }, 500)
  })
  host.route(
    CALLBACK_MOUNT_PATH,
    createCleanupReceiver(env) as unknown as Hono<HonoEnv>
  )
  return host.fetch(request, env)
}

/** `/_waker` 子应用（在 index.ts 里 `app.route(CALLBACK_MOUNT_PATH, wakerRoutes())`）。 */
export function wakerRoutes(): Hono<HonoEnv> {
  const routes = new Hono<HonoEnv>()
  routes.all("*", (c) => forwardToReceiver(c.req.raw, c.env))
  return routes
}
