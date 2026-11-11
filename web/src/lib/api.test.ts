import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, adminApi, describeApiError, pagesApi } from "@/lib/api"
import { describeWebAuthnError } from "@/lib/webauthn"

/**
 * 规格 §8「TOTP 两步登录」的失败提示。
 *
 * 后端的 401 一个状态码两种含义：两步验证输错码 / 挑战过期 / 账号密码错，
 * 与会话中间件的 `Unauthorized`（Cookie 失效）同码。这里把每个入口逐一钉住，
 * 防止统一 401 处理再把「验证码不对」说成「登录状态已失效」。
 * 断言的英文原文即 worker 的冻结返回（worker/src/routes/auth.ts、auth-2fa.ts）。
 */
function apiError(
  status: number,
  message: string,
  path: string,
  code?: string,
  retryAfter?: number
) {
  return new ApiError(
    status,
    message,
    code,
    retryAfter,
    { error: message },
    path
  )
}

const SESSION_EXPIRED = "登录状态已失效，请重新登录。"

describe("describeApiError：登录 / 两步验证入口", () => {
  it("两步验证输错码 → 提示验证码不正确，不再说会话过期", () => {
    const error = apiError(401, "Invalid verification code", "/auth/2fa/verify")
    expect(describeApiError(error)).toBe("验证码不正确，请重新输入。")
    expect(describeApiError(error)).not.toBe(SESSION_EXPIRED)
  })

  it("同一 tempToken 失败 5 次后挑战作废 → 提示返回上一步重新登录", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/verify"
    )
    expect(describeApiError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })

  it("两步验证尝试过于频繁 → 提示稍后再试", () => {
    const error = apiError(
      429,
      "Too many requests",
      "/auth/2fa/verify",
      "RATE_LIMITED"
    )
    expect(describeApiError(error)).toBe("尝试次数过多，请稍后再试。")
  })

  it("邮箱或密码错 → 提示邮箱或密码不正确，不再说会话过期", () => {
    const error = apiError(401, "Invalid credentials", "/auth/login")
    expect(describeApiError(error)).toBe("邮箱或密码不正确。")
  })

  it("Passkey 登录验证未通过 → 中文提示，不摆英文原文", () => {
    const error = apiError(
      401,
      "Verification failed",
      "/auth/2fa/passkey/authenticate/verify"
    )
    expect(describeApiError(error)).toBe("Passkey 验证未通过，请重试。")
  })

  it("Passkey 挑战过期 → 同「两步验证已失效」", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/passkey/authenticate/options"
    )
    expect(describeApiError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })

  it("设置页启用 TOTP 时输错码（400 Invalid code）→ 同一句验证码提示", () => {
    const error = apiError(400, "Invalid code", "/auth/2fa/totp/enable")
    expect(describeApiError(error)).toBe("验证码不正确，请重新输入。")
  })

  it("登录表单上没见过的 401 文案也不说会话过期（后端改词的兜底）", () => {
    const error = apiError(401, "Nope", "/auth/2fa/verify")
    expect(describeApiError(error)).toBe("验证未通过，请重试。")
  })

  it("describeWebAuthnError 对接口错误也走统一翻译", () => {
    const error = apiError(
      401,
      "Invalid or expired 2FA session",
      "/auth/2fa/passkey/authenticate/verify"
    )
    expect(describeWebAuthnError(error)).toBe(
      "两步验证已失效，请返回上一步重新登录。"
    )
  })
})

describe("describeApiError：会话过期的路径不受影响", () => {
  it("/me 的 401 仍然提示重新登录", () => {
    const error = apiError(401, "Unauthorized", "/me")
    expect(describeApiError(error)).toBe(SESSION_EXPIRED)
  })

  it("业务接口的 401 仍然提示重新登录", () => {
    expect(describeApiError(apiError(401, "Unauthorized", "/pages"))).toBe(
      SESSION_EXPIRED
    )
    expect(
      describeApiError(apiError(401, "Unauthorized", "/admin/users"))
    ).toBe(SESSION_EXPIRED)
  })

  it("没有路径信息的 401（老调用点）仍按会话过期处理", () => {
    expect(describeApiError(new ApiError(401, "Unauthorized"))).toBe(
      SESSION_EXPIRED
    )
  })

  it("非 ApiError 仍是网络异常", () => {
    expect(describeApiError(new Error("boom"))).toBe("网络异常，请稍后重试")
  })
})

describe("describeApiError：空间相关错误码", () => {
  it("空间删除 / 重名保护用中文说明，不摆后端英文原文", () => {
    expect(
      describeApiError(
        apiError(409, "Space is not empty", "/spaces/s1", "SPACE_NOT_EMPTY")
      )
    ).toBe(
      "空间里还有页面，请先把页面移动到其他空间，或彻底删除回收站里的页面。"
    )
    expect(
      describeApiError(
        apiError(
          409,
          "Default space protected",
          "/spaces/s1",
          "SPACE_DEFAULT_PROTECTED"
        )
      )
    ).toBe("默认空间不能删除。")
    expect(
      describeApiError(
        apiError(
          409,
          "Last space admin",
          "/spaces/s1/members/u2",
          "LAST_SPACE_ADMIN"
        )
      )
    ).toBe("空间至少需要保留一名管理员。")
    expect(
      describeApiError(
        apiError(404, "Space not found", "/spaces/s1", "SPACE_NOT_FOUND")
      )
    ).toBe("空间不存在，或你已不是它的成员。")
    // 成员在别处被移除 / 候选用户在添加到一半时消失
    expect(
      describeApiError(
        apiError(
          404,
          "Member not found",
          "/spaces/s1/members/u2",
          "MEMBER_NOT_FOUND"
        )
      )
    ).toBe("这个成员已经不在空间里了。")
    expect(
      describeApiError(
        apiError(404, "User not found", "/spaces/s1/members", "USER_NOT_FOUND")
      )
    ).toBe("找不到这个用户。")
  })

  it("名称与角色校验的文案", () => {
    expect(
      describeApiError(
        apiError(400, "Invalid space name", "/spaces", "INVALID_SPACE_NAME")
      )
    ).toBe("空间名称需为 1–64 个字符。")
    expect(
      describeApiError(
        apiError(400, "Invalid role", "/spaces/s1/members", "INVALID_ROLE")
      )
    ).toBe("成员角色不合法。")
  })
})

describe("describeApiError：版本治理相关错误码", () => {
  it("最新一条不许删、保留数不限时不能全站修剪", () => {
    expect(
      describeApiError(
        apiError(
          409,
          "Cannot delete the latest revision",
          "/pages/p1/revisions/r1",
          "REVISION_IS_LATEST"
        )
      )
    ).toBe("每页最新的一条版本不能删除。")
    expect(
      describeApiError(
        apiError(
          409,
          "Revision retention is unlimited",
          "/admin/revisions/prune",
          "RETENTION_UNLIMITED"
        )
      )
    ).toBe("当前设置为不限，没有可修剪的版本。")
  })

  it("版本内容无法按当前 schema 渲染 → 说明不能查看或回滚", () => {
    expect(
      describeApiError(
        apiError(
          422,
          "Revision content cannot be rendered",
          "/pages/p1/revisions/r1",
          "REVISION_UNRENDERABLE"
        )
      )
    ).toBe("这个版本的内容无法在当前编辑器版本下渲染，暂时不能查看或回滚。")
  })

  it("正文取不到（内容存储不可用/对象缺失）→ 指向内容存储，不说成内容坏了", () => {
    expect(
      describeApiError(
        apiError(
          500,
          "Page content unavailable",
          "/pages/p1/revisions/r1",
          "CONTENT_MISSING"
        )
      )
    ).toBe(
      "页面正文暂时取不到（内容存储不可用或对象缺失），请稍后重试；持续失败请让管理员检查内容存储（ciki-content）。"
    )
  })

  it("保留数校验失败的 400 用中文说明，不摆后端英文原文", () => {
    expect(
      describeApiError(
        apiError(
          400,
          "revisionRetentionLimit must be a positive integer or null",
          "/admin/settings"
        )
      )
    ).toBe("保留数需为不小于 1 的整数，留空表示不限。")
  })
})

/**
 * 邮箱找回密码（契约 #48/#51）的三个入口：错码、凭证失效、强度不足都是
 * 用户看得懂的结论句，且都不能被统一 401 处理说成「登录状态已失效」。
 * 断言的英文原文即 worker/src/routes/auth.ts 的冻结返回。
 */
describe("describeApiError：找回密码的三个入口", () => {
  it("错码 / 过期 → 同一句验证码提示，不区分账号是否存在", () => {
    const error = apiError(
      400,
      "Invalid or expired code",
      "/auth/password/verify",
      "INVALID_CODE"
    )
    expect(describeApiError(error)).toBe("验证码不正确或已过期，请重新获取。")
    expect(describeApiError(error)).not.toBe(SESSION_EXPIRED)
  })

  it("同一个 INVALID_CODE 在邮箱 2FA 启用处仍是「请重新输入」，不被改写", () => {
    const error = apiError(
      400,
      "Invalid code",
      "/auth/2fa/email-otp/enable",
      "INVALID_CODE"
    )
    expect(describeApiError(error)).toBe("验证码不正确，请重新输入。")
  })

  it("resetToken 失效 → 说清要重新获取验证码", () => {
    const error = apiError(
      400,
      "Invalid or expired reset token",
      "/auth/password/reset",
      "INVALID_RESET_TOKEN"
    )
    expect(describeApiError(error)).toBe(
      "这次重置已失效（验证码换来的凭证过期或已被使用），请重新获取验证码。"
    )
  })

  it("密码强度不足 → 与注册 / 改密同一句「至少 8 位」", () => {
    const error = apiError(
      400,
      "Password must be at least 8 characters",
      "/auth/password/reset",
      "WEAK_PASSWORD"
    )
    expect(describeApiError(error)).toBe("密码至少 8 位。")
  })

  it("邮箱格式错 → 提示检查邮箱", () => {
    const error = apiError(
      400,
      "Invalid email format",
      "/auth/password/forgot",
      "INVALID_EMAIL"
    )
    expect(describeApiError(error)).toBe("邮箱格式不正确，请检查后重试。")
  })

  it("找回密码端点上没见过文案的 401 也不说会话过期", () => {
    expect(
      describeApiError(apiError(401, "Nope", "/auth/password/verify"))
    ).toBe("验证未通过，请重试。")
  })
})

/**
 * 注册邮箱验证（单 A #85 冻结契约）：登录门禁的 403 与验证端点的 400 各一句
 * 用户看得懂的话；验证端点的错码同时可能是「未知邮箱」，只说到验证码这一层。
 */
describe("describeApiError：注册邮箱验证", () => {
  it("登录被门禁拦下 → 说清要先验证邮箱，不是密码错", () => {
    const error = apiError(
      403,
      "Email not verified",
      "/auth/login",
      "EMAIL_NOT_VERIFIED"
    )
    expect(describeApiError(error)).toBe("邮箱还没有验证，请先完成邮箱验证。")
    expect(describeApiError(error)).not.toBe("验证未通过，请重试。")
  })

  it("验证端点的错码 / 过期 / 未知邮箱同形 → 只说验证码不对或已过期", () => {
    const error = apiError(
      400,
      "Invalid or expired code",
      "/auth/email/verify",
      "INVALID_CODE"
    )
    expect(describeApiError(error)).toBe("验证码不正确或已过期。")
  })

  it("验证端点上的 401（代理 / 中间件）不说会话过期", () => {
    expect(
      describeApiError(apiError(401, "Unauthorized", "/auth/email/verify"))
    ).toBe("验证未通过，请重试。")
  })

  it("站点没配发信时重发验证码 → 指向系统管理 → 邮件配置", () => {
    const error = apiError(
      503,
      "Email delivery is not configured",
      "/auth/email/resend",
      "EMAIL_NOT_CONFIGURED"
    )
    expect(describeApiError(error)).toBe(
      "还没有配置可用的 SMTP，请先在系统管理 → 邮件配置里填写。"
    )
  })
})

/**
 * 用户名唯一（契约「PUT /api/me/profile」）：撞名 409 `USERNAME_TAKEN`。界面只说结果，
 * 不解释唯一索引之类的机制；也不能因为 409 兜底是 `error.message` 就把后端英文原文
 * 摆给用户（改用户名的唯一入口是个人资料页，失败文案统一走 describeApiError）。
 */
describe("describeApiError：用户名撞名", () => {
  it("改用户名撞名（409 USERNAME_TAKEN）→ 中文提示，不漏英文原文", () => {
    const error = apiError(
      409,
      "Username taken",
      "/me/profile",
      "USERNAME_TAKEN"
    )
    expect(describeApiError(error)).toBe("这个用户名已经有人用了，请换一个。")
    expect(describeApiError(error)).not.toContain("Username")
    expect(describeApiError(error)).not.toBe("当前状态冲突，请刷新后重试。")
  })
})

/** 阅读页「下载 .md」的传输层：一条 GET 拿二进制，错误仍是 JSON 口径。 */
function stubFetch(response: Response) {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >(async () => response)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("pagesApi.download：服务端分流的二进制下载", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("请求 /pages/:id/download，带会话 Cookie，回 blob 与 Content-Disposition", async () => {
    const fetchMock = stubFetch(
      new Response("PK", {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="ciki-page.zip"; filename*=UTF-8''${encodeURIComponent("部署.zip")}`
        }
      })
    )

    const result = await pagesApi.download(1)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/pages/1/download")
    expect(init?.method).toBe("GET")
    expect(init?.credentials).toBe("include")
    expect(init?.cache).toBe("no-store")
    expect(result.contentDisposition).toContain("filename*=UTF-8")
    expect(result.blob.type).toBe("application/zip")
    expect(await result.blob.text()).toBe("PK")
  })

  it("非 2xx 与 JSON 请求同口径抛 ApiError，走既有错误提示", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ error: "Not found", code: "PAGE_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    )

    const failure = await pagesApi.download(9).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).status).toBe(404)
    expect((failure as ApiError).code).toBe("PAGE_NOT_FOUND")
    expect((failure as ApiError).path).toBe("/pages/9/download")
    expect(describeApiError(failure)).toBe("对象不存在，或已被删除。")
  })
})

describe("describeApiError：孤儿图片清理接口", () => {
  it("另一轮清理在跑（409）→ 中文提示，不摆英文原文", () => {
    const error = apiError(
      409,
      "Cleanup already running",
      "/admin/r2-cleanup",
      "CLEANUP_IN_PROGRESS",
      42
    )
    expect(describeApiError(error)).toBe("清理正在进行，请稍后再试。")
    expect(describeApiError(error)).not.toContain("Cleanup")
  })

  it("扫描期异常（500 Cleanup failed）→ 中文提示", () => {
    const error = apiError(500, "Cleanup failed", "/admin/r2-cleanup")
    expect(describeApiError(error)).toBe("清理失败，请稍后重试。")
  })
})

/** 整数化后的 URL 形态：id 直接进路径，编辑态只有 `?format=json` 这一处查询参数。 */
describe("整数 id 与新增端点的 URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("编辑态详情走 ?format=json，普通详情不带任何查询参数", async () => {
    // stubFetch 复用同一个 Response 实例，body 只能读一次：每次请求单独铺一次
    const editorFetch = stubFetch(new Response("{}", { status: 200 }))
    await pagesApi.getForEditor(12)
    expect(editorFetch.mock.calls[0][0]).toBe("/api/pages/12?format=json")

    const readFetch = stubFetch(new Response("{}", { status: 200 }))
    await pagesApi.get(12)
    expect(readFetch.mock.calls[0][0]).toBe("/api/pages/12")
  })

  it("版本按 version_no 进路径，不再有版本行 id", async () => {
    const urls: string[] = []
    for (const run of [
      () => pagesApi.revision(12, 3),
      () => pagesApi.restoreRevision(12, 3),
      () => pagesApi.deleteRevision(12, 3)
    ]) {
      const fetchMock = stubFetch(new Response("{}", { status: 200 }))
      await run()
      urls.push(fetchMock.mock.calls[0][0])
    }

    expect(urls).toEqual([
      "/api/pages/12/revisions/3",
      "/api/pages/12/revisions/3/restore",
      "/api/pages/12/revisions/3"
    ])
  })

  it("库体积读 /admin/storage，字段名按冻结契约", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          pageCount: 12,
          trashedPageCount: 3,
          revisionCount: 40,
          databaseSizeBytes: 1024,
          sizeScope: "own-database",
          measure: "cloudflare-d1-api"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )

    const storage = await adminApi.storage()

    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/storage")
    expect(storage.pageCount).toBe(12)
    expect(storage.databaseSizeBytes).toBe(1024)
  })
})
