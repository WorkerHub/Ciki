import { BookOpen, Check, Copy, KeySquare, PenLine } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { TokenSpaceScope } from "@/components/TokenSpaceScope"
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
  type ApiTokenSpaces,
  type ApiTokenStatus,
  describeApiError,
  meApi,
  type TokenSpaceIds
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

type TokenKind = "import" | "read" | "write"

type ConfirmAction = "rotate" | "revoke"

interface TokenKindConfig {
  /** 卡片标题、空态主文案、提示与确认框一律存 key，渲染时再 t()。 */
  titleKey: string
  icon: typeof KeySquare
  emptyKey: string
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
    /**
     * 只改空间范围、不换令牌。导入令牌没有范围（服务端那条接口也不回
     * `spaceIds`），不填就不会渲染范围编辑，保持一期原样。
     */
    saveSpaces?: (spaceIds: TokenSpaceIds) => Promise<ApiTokenSpaces>
  }
}

/**
 * 两种个人令牌的文案与接口。交互与结构完全一致（生成 / 重置 / 吊销、
 * 一次性明文），只有名词与生效对象不同，因此共用一套实现。
 */
const KINDS: Record<TokenKind, TokenKindConfig> = {
  import: {
    titleKey: "settings.tokens.import.title",
    icon: KeySquare,
    emptyKey: "settings.tokens.import.empty",
    notices: {
      generated: "settings.tokens.notices.generated",
      rotated: "settings.tokens.notices.rotated",
      regenerated: "settings.tokens.notices.regenerated",
      revoked: "settings.tokens.import.revoked",
      missing: "settings.tokens.notices.missing"
    },
    confirm: {
      rotateTitle: "settings.tokens.import.rotateTitle",
      rotateDescription: "settings.tokens.import.rotateDescription",
      revokeTitle: "settings.tokens.import.revokeTitle",
      revokeDescription: "settings.tokens.import.revokeDescription"
    },
    api: {
      status: () => meApi.importToken(),
      issue: () => meApi.createImportToken(),
      revoke: () => meApi.revokeImportToken()
    }
  },
  read: {
    titleKey: "settings.tokens.read.title",
    icon: BookOpen,
    emptyKey: "settings.tokens.read.empty",
    notices: {
      generated: "settings.tokens.notices.generated",
      rotated: "settings.tokens.notices.rotated",
      regenerated: "settings.tokens.notices.regenerated",
      revoked: "settings.tokens.read.revoked",
      missing: "settings.tokens.notices.missing"
    },
    confirm: {
      rotateTitle: "settings.tokens.read.rotateTitle",
      rotateDescription: "settings.tokens.read.rotateDescription",
      revokeTitle: "settings.tokens.read.revokeTitle",
      revokeDescription: "settings.tokens.read.revokeDescription"
    },
    api: {
      status: () => meApi.readToken(),
      issue: () => meApi.createReadToken(),
      revoke: () => meApi.revokeReadToken(),
      saveSpaces: (spaceIds) => meApi.setReadTokenSpaces(spaceIds)
    }
  },
  write: {
    titleKey: "settings.tokens.write.title",
    icon: PenLine,
    emptyKey: "settings.tokens.write.empty",
    notices: {
      generated: "settings.tokens.notices.generated",
      rotated: "settings.tokens.notices.rotated",
      regenerated: "settings.tokens.notices.regenerated",
      revoked: "settings.tokens.write.revoked",
      missing: "settings.tokens.notices.missing"
    },
    confirm: {
      rotateTitle: "settings.tokens.write.rotateTitle",
      rotateDescription: "settings.tokens.write.rotateDescription",
      revokeTitle: "settings.tokens.write.revokeTitle",
      revokeDescription: "settings.tokens.write.revokeDescription"
    },
    api: {
      status: () => meApi.writeToken(),
      issue: () => meApi.createWriteToken(),
      revoke: () => meApi.revokeWriteToken(),
      saveSpaces: (spaceIds) => meApi.setWriteTokenSpaces(spaceIds)
    }
  }
}

/**
 * 个人 API 令牌卡（导入令牌 / 只读接口令牌 / 读写接口令牌共用）：生成 / 重置 / 吊销，
 * 只读与读写两种还带空间范围编辑（导入令牌没有范围，不渲染那一块）。
 *
 * 明文只在生成 / 重置那一次显示，之后只显示状态 —— 服务端只存 SHA-256，
 * GET 从不回哈希。三个接口都是 Cookie 会话鉴权，与令牌本身的用途无关；
 * 明文只活在组件 state 里，不写 storage、不进 console。
 */
export function ApiTokenCard({ kind }: { kind: TokenKind }) {
  const config = KINDS[kind]
  const { api } = config
  const Icon = config.icon
  const { t } = useTranslation()
  const [status, setStatus] = useState<ApiTokenStatus | null>(null)
  const [issued, setIssued] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  /** 成功提示存 key，渲染时再 t()：切语言后提示跟着变。 */
  const [noticeKey, setNoticeKey] = useState("")
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
    setNoticeKey("")
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
        revokedAt: null,
        // 生成 / 重置不带 spaceIds，服务端保留现有范围；界面跟着沿用，别闪回
        // 「全部空间」。
        spaceIds: previous?.spaceIds ?? null
      })
      if (previous?.active) setNoticeKey(config.notices.rotated)
      else if (previous?.revokedAt) setNoticeKey(config.notices.regenerated)
      else setNoticeKey(config.notices.generated)
    } catch (issueError) {
      setError(describeApiError(issueError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setError("")
    setNoticeKey("")
    setCopied(false)
    setConfirm(null)
    setBusy(true)
    try {
      await api.revoke()
      setIssued("")
      setNoticeKey(config.notices.revoked)
      await load()
    } catch (revokeError) {
      // 契约里只有「从未生成」才回 404：多半是别处已经吊销，刷新状态即可
      if (revokeError instanceof ApiError && revokeError.status === 404) {
        setIssued("")
        setNoticeKey(config.notices.missing)
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
      setError(t("settings.tokens.common.copyFailed"))
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
          {t(config.titleKey)}
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
                  {t("common.retry")}
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("settings.tokens.common.loading")}
              </p>
            )}
          </div>
        ) : (
          <>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {noticeKey ? (
              <p
                role="status"
                className="text-xs text-emerald-700 dark:text-emerald-300"
              >
                {t(noticeKey)}
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
                      {t("settings.tokens.common.active")}
                    </Badge>
                  ) : null}
                  {revoked ? (
                    <Badge variant="secondary">
                      {t("settings.tokens.common.revoked")}
                    </Badge>
                  ) : null}
                  {empty ? (
                    <span className="text-sm font-medium">
                      {t(config.emptyKey)}
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {active ? (
                    <>
                      <span>
                        {t("settings.tokens.common.createdAt", {
                          time: formatDateTime(current.createdAt)
                        })}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        {t("settings.tokens.common.lastUsed", {
                          time: current.lastUsedAt
                            ? formatDateTime(current.lastUsedAt)
                            : t("settings.tokens.common.neverUsed")
                        })}
                      </span>
                    </>
                  ) : null}
                  {revoked ? (
                    <>
                      <span>
                        {t("settings.tokens.common.revokedAt", {
                          time: formatDateTime(current.revokedAt)
                        })}
                      </span>
                      {current.createdAt ? (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>
                            {t("settings.tokens.common.originalCreatedAt", {
                              time: formatDateTime(current.createdAt)
                            })}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {empty ? (
                    <span>{t("settings.tokens.common.emptyHint")}</span>
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
                    {busy
                      ? t("settings.tokens.common.generating")
                      : t("settings.tokens.common.generate")}
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
                      {t("settings.tokens.common.rotate")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirm("revoke")}
                    >
                      {t("settings.tokens.common.revoke")}
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
                    {busy
                      ? t("settings.tokens.common.generating")
                      : t("settings.tokens.common.regenerate")}
                  </Button>
                ) : null}
              </div>
            </div>

            {issued ? (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  {t("settings.tokens.common.plaintextHint")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all select-all">
                    {issued}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={
                      copied
                        ? t("settings.tokens.common.copied")
                        : t("settings.tokens.common.copyLabel")
                    }
                    onClick={() => void copy()}
                  >
                    {copied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                    {copied
                      ? t("settings.tokens.common.copied")
                      : t("settings.tokens.common.copy")}
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
                    {t("settings.tokens.common.saved")}
                  </Button>
                </div>
              </div>
            ) : null}

            {config.api.saveSpaces ? (
              <TokenSpaceScope
                spaceIds={current.spaceIds ?? null}
                save={config.api.saveSpaces}
                onSaved={(spaceIds) =>
                  setStatus((previous) =>
                    previous ? { ...previous, spaceIds } : previous
                  )
                }
                disabled={busy}
              />
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
            <AlertDialogTitle>{t(config.confirm.rotateTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(config.confirm.rotateDescription)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void issue()}>
              {t("settings.tokens.common.rotateConfirm")}
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
            <AlertDialogTitle>{t(config.confirm.revokeTitle)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(config.confirm.revokeDescription)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {t("settings.tokens.common.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
