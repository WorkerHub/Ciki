import { Check, Copy, KeySquare } from "lucide-react"
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import {
  ApiError,
  describeApiError,
  type ImportTokenStatus,
  meApi
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

type ConfirmAction = "rotate" | "revoke"

/**
 * 导入令牌卡（规格 §12.1）：当前用户生成 / 重置 / 吊销自己的导入令牌。
 *
 * 明文只在生成 / 重置那一次显示，之后只显示状态 —— 服务端只存 SHA-256，
 * GET 从不回哈希。三个接口都是 Cookie 会话鉴权，与导入接口（Bearer 令牌）
 * 职责分离；明文只活在组件 state 里，不写 storage、不进 console。
 */
export function ImportTokenCard() {
  const [status, setStatus] = useState<ImportTokenStatus | null>(null)
  const [issued, setIssued] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)

  const load = useCallback(async () => {
    setError("")
    try {
      setStatus(await meApi.importToken())
    } catch (loadError) {
      setStatus(null)
      setError(describeApiError(loadError))
    }
  }, [])

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
      const result = await meApi.createImportToken()
      setIssued(result.token)
      setStatus({
        active: true,
        createdAt: result.createdAt,
        lastUsedAt: null,
        revokedAt: null
      })
      if (previous?.active) setNotice("令牌已重置，旧令牌立即失效。")
      else if (previous?.revokedAt) setNotice("已重新生成令牌。")
      else setNotice("令牌已生成。")
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
      await meApi.revokeImportToken()
      setIssued("")
      setNotice("令牌已吊销，插件里的旧令牌立即失效。")
      await load()
    } catch (revokeError) {
      // 契约里只有「从未生成」才回 404：多半是别处已经吊销，刷新状态即可
      if (revokeError instanceof ApiError && revokeError.status === 404) {
        setIssued("")
        setNotice("令牌已不存在，已刷新状态。")
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
          <KeySquare
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          导入令牌
        </CardTitle>
        <CardDescription>
          浏览器插件用它把页面导入
          ciki。令牌权限等同你本人，只能调用导入接口，不能用来登录网页。
        </CardDescription>
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
                    <span className="text-sm font-medium">还没有导入令牌</span>
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
            <AlertDialogTitle>重置导入令牌？</AlertDialogTitle>
            <AlertDialogDescription>
              旧令牌立即失效，插件里要重新填新令牌。新令牌同样只显示这一次。
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
            <AlertDialogTitle>吊销导入令牌？</AlertDialogTitle>
            <AlertDialogDescription>
              吊销后插件无法再导入页面，直到你重新生成令牌。
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
