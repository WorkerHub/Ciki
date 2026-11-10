import { BookOpen, Check, Copy, KeySquare } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ApiError,
  type ApiTokenIssued,
  type ApiTokenStatus,
  describeApiError,
  meApi
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

type TokenKind = "import" | "read"

type ConfirmAction = "rotate" | "revoke"

interface TokenKindConfig {
  title: string
  icon: typeof KeySquare
  /** 空态主文案（「还没有导入令牌」/「还没有只读接口令牌」）。 */
  emptyLabel: string
  notices: {
    generated: string
    rotated: string
    regenerated: string
    revoked: string
    /** 吊销时服务端回 404：多半是别处已经吊销。 */
    missing: string
  }
  confirm: {
    rotateTitle: string
    rotateDescription: string
    revokeTitle: string
    revokeDescription: string
  }
  /** 三个接口都在调用时取，测试替换 meApi 方法后卡片立刻跟着换。 */
  api: {
    status: () => Promise<ApiTokenStatus>
    issue: () => Promise<ApiTokenIssued>
    revoke: () => Promise<{ success: true }>
  }
}

/**
 * 两种个人令牌的文案与接口。交互与结构完全一致（生成 / 重置 / 吊销、
 * 一次性明文），只有名词与生效对象不同，因此共用一套实现。
 */
const KINDS: Record<TokenKind, TokenKindConfig> = {
  import: {
    title: "导入令牌",
    icon: KeySquare,
    emptyLabel: "还没有导入令牌",
    notices: {
      generated: "令牌已生成。",
      rotated: "令牌已重置，旧令牌立即失效。",
      regenerated: "已重新生成令牌。",
      revoked: "令牌已吊销，插件里的旧令牌立即失效。",
      missing: "令牌已不存在，已刷新状态。"
    },
    confirm: {
      rotateTitle: "重置导入令牌？",
      rotateDescription:
        "旧令牌立即失效，插件里要重新填新令牌。新令牌同样只显示这一次。",
      revokeTitle: "吊销导入令牌？",
      revokeDescription: "吊销后插件无法再导入页面，直到你重新生成令牌。"
    },
    api: {
      status: () => meApi.importToken(),
      issue: () => meApi.createImportToken(),
      revoke: () => meApi.revokeImportToken()
    }
  },
  read: {
    title: "只读接口令牌",
    icon: BookOpen,
    emptyLabel: "还没有只读接口令牌",
    notices: {
      generated: "令牌已生成。",
      rotated: "令牌已重置，旧令牌立即失效。",
      regenerated: "已重新生成令牌。",
      revoked: "令牌已吊销，外部应用里的旧令牌立即失效。",
      missing: "令牌已不存在，已刷新状态。"
    },
    confirm: {
      rotateTitle: "重置只读接口令牌？",
      rotateDescription:
        "旧令牌立即失效，外部只读客户端要重新填新令牌。新令牌同样只显示这一次。",
      revokeTitle: "吊销只读接口令牌？",
      revokeDescription: "吊销后外部应用无法再读取页面，直到你重新生成令牌。"
    },
    api: {
      status: () => meApi.readToken(),
      issue: () => meApi.createReadToken(),
      revoke: () => meApi.revokeReadToken()
    }
  }
}

/**
 * 个人 API 令牌卡（导入令牌 / 只读接口令牌共用）：生成 / 重置 / 吊销。
 *
 * 明文只在生成 / 重置那一次显示，之后只显示状态 —— 服务端只存 SHA-256，
 * GET 从不回哈希。三个接口都是 Cookie 会话鉴权，与令牌本身的用途无关；
 * 明文只活在组件 state 里，不写 storage、不进 console。
 */
export function ApiTokenCard({ kind }: { kind: TokenKind }) {
  const config = KINDS[kind]
  const { api } = config
  const Icon = config.icon
  const [status, setStatus] = useState<ApiTokenStatus | null>(null)
  const [issued, setIssued] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)

  const load = useCallback(async () => {
    setError("")
    try {
      setStatus(await api.status())
    } catch (loadError) {
      setStatus(null)
      setError(describeApiError(loadError))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const issue = async () => {
    setError("")
    setNotice("")
    setCopied(false)
    setConfirm(null)
    setBusy(true)
    const previous = status
    try {
      const result = await api.issue()
      setIssued(result.token)
      setStatus({
        active: true,
        createdAt: result.createdAt,
        lastUsedAt: null,
        revokedAt: null
      })
      if (previous?.active) setNotice(config.notices.rotated)
      else if (previous?.revokedAt) setNotice(config.notices.regenerated)
      else setNotice(config.notices.generated)
    } catch (issueError) {
      setError(describeApiError(issueError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setError("")
    setNotice("")
    setCopied(false)
    setConfirm(null)
    setBusy(true)
    try {
      await api.revoke()
      setIssued("")
      setNotice(config.notices.revoked)
      await load()
    } catch (revokeError) {
      // 契约里只有「从未生成」才回 404：多半是别处已经吊销，刷新状态即可
      if (revokeError instanceof ApiError && revokeError.status === 404) {
        setIssued("")
        setNotice(config.notices.missing)
        await load()
      } else {
        setError(describeApiError(revokeError))
      }
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!issued) return
    setError("")
    try {
      await navigator.clipboard.writeText(issued)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
      setError("复制失败，请手动选中令牌文本复制。")
    }
  }

  const current = status
  const active = current?.active === true
  const revoked =
    current !== null && !current.active && current.revokedAt !== null
  const empty = current !== null && !current.active && !revoked

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          {config.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {current === null ? (
          <div className="space-y-2">
            {error ? (
              <>
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  重试
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">读取中…</p>
            )}
          </div>
        ) : (
          <>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p
                role="status"
                className="text-xs text-emerald-700 dark:text-emerald-300"
              >
                {notice}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {active ? (
                    <Badge
                      variant="secondary"
                      className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    >
                      生效中
                    </Badge>
                  ) : null}
                  {revoked ? <Badge variant="secondary">已吊销</Badge> : null}
                  {empty ? (
                    <span className="text-sm font-medium">
                      {config.emptyLabel}
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {active ? (
                    <>
                      <span>创建于 {formatDateTime(current.createdAt)}</span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        最近使用{" "}
                        {current.lastUsedAt
                          ? formatDateTime(current.lastUsedAt)
                          : "尚未使用"}
                      </span>
                    </>
                  ) : null}
                  {revoked ? (
                    <>
                      <span>吊销于 {formatDateTime(current.revokedAt)}</span>
                      {current.createdAt ? (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>
                            原令牌创建于 {formatDateTime(current.createdAt)}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {empty ? (
                    <span>生成后明文只显示这一次，离开设置页就看不到了。</span>
                  ) : null}
                </p>
              </div>

              <div className="flex items-center gap-1.5">
                {empty ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void issue()}
                  >
                    {busy ? "生成中…" : "生成令牌"}
                  </Button>
                ) : null}
                {active ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirm("rotate")}
                    >
                      重置
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirm("revoke")}
                    >
                      吊销
                    </Button>
                  </>
                ) : null}
                {revoked ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void issue()}
                  >
                    {busy ? "生成中…" : "重新生成"}
                  </Button>
                ) : null}
              </div>
            </div>

            {issued ? (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  这串令牌只显示这一次，离开设置页后无法再查看。请现在复制并妥善保存。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all select-all">
                    {issued}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={copied ? "已复制" : "复制令牌"}
                    onClick={() => void copy()}
                  >
                    {copied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                    {copied ? "已复制" : "复制"}
                  </Button>
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      setIssued("")
                      setCopied(false)
                    }}
                  >
                    我已保存
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <AlertDialog
        open={confirm === "rotate"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{config.confirm.rotateTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {config.confirm.rotateDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void issue()}>
              重置令牌
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirm === "revoke"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{config.confirm.revokeTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {config.confirm.revokeDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void revoke()}
            >
              吊销令牌
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
