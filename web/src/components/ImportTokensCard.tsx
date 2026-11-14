import { Check, Copy, PlugZap, Plus } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ApiError,
  describeApiError,
  type ImportTokenSummary,
  meApi
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

/** 名称上限（契约：trim 后 ≤40 码点）。 */
const NAME_MAX = 40

/** 按码点数长度：`[...name]` 把 emoji 这类代理对算一个字，与契约一致。 */
function nameLength(name: string): number {
  return [...name].length
}

/**
 * 「浏览器插件」卡（接口三期 §5）：多条插件凭证的列表 + 新建 / 吊销。
 *
 * 凭证只给插件用（`Authorization: Bearer`），没有空间范围与类型；一条吊销不影响其余。
 * 明文只在创建那一次出现一次，创建成功后提示粘贴去向。
 */
export function ImportTokensCard() {
  const { t } = useTranslation()

  const [tokens, setTokens] = useState<ImportTokenSummary[] | null>(null)
  const [loadingError, setLoadingError] = useState("")
  const [error, setError] = useState("")
  /** 成功提示存 key，渲染时再 t()：切语言后提示跟着变。 */
  const [noticeKey, setNoticeKey] = useState("")
  const [issued, setIssued] = useState("")
  /** 明文属于哪一条：吊销别的凭证时不能把还没保存的明文一起清掉。 */
  const [issuedId, setIssuedId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [createError, setCreateError] = useState("")
  const [revoking, setRevoking] = useState<ImportTokenSummary | null>(null)

  const load = useCallback(async () => {
    setLoadingError("")
    try {
      setTokens((await meApi.importTokens()).tokens)
    } catch (loadError) {
      setTokens(null)
      setLoadingError(describeApiError(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const trimmedName = name.trim()
  const nameTooLong = nameLength(trimmedName) > NAME_MAX

  const create = async () => {
    if (busy || nameTooLong) return
    setCreateError("")
    setNoticeKey("")
    setCopied(false)
    setBusy(true)
    try {
      // 留空就不带 name：自动名以服务端落的为准，前端不自己编
      const result = await meApi.createImportToken(trimmedName || undefined)
      setIssued(result.token)
      setIssuedId(result.id)
      setCreating(false)
      setName("")
      setNoticeKey("settings.tokens.plugin.created")
      await load()
    } catch (createFailure) {
      setCreateError(describeApiError(createFailure))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (token: ImportTokenSummary) => {
    setError("")
    setNoticeKey("")
    setRevoking(null)
    setBusy(true)
    try {
      await meApi.revokeImportToken(token.id)
      // 只清掉这条自己刚生成的明文，别的凭证的明文还得让用户复制走
      if (issuedId === token.id) {
        setIssued("")
        setIssuedId(null)
        setCopied(false)
      }
      setNoticeKey("settings.tokens.plugin.revoked")
      await load()
    } catch (revokeFailure) {
      if (revokeFailure instanceof ApiError && revokeFailure.status === 404) {
        setNoticeKey("settings.tokens.plugin.missing")
        await load()
      } else {
        setError(describeApiError(revokeFailure))
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

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <PlugZap
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("settings.tokens.plugin.title")}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            disabled={busy || creating}
            aria-expanded={creating}
            onClick={() => {
              setCreating(true)
              setCreateError("")
              setNoticeKey("")
            }}
          >
            <Plus aria-hidden="true" />
            {t("settings.tokens.plugin.new")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
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

        {issued ? (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">
              {t("settings.tokens.plugin.plaintextHint")}
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
                    : t("settings.tokens.plugin.copyLabel")
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
            <p className="mt-2 text-xs text-muted-foreground">
              {t("settings.tokens.plugin.pasteHint")}
            </p>
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                size="xs"
                variant="secondary"
                onClick={() => {
                  setIssued("")
                  setIssuedId(null)
                  setCopied(false)
                }}
              >
                {t("settings.tokens.common.saved")}
              </Button>
            </div>
          </div>
        ) : null}

        {creating ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-import-token-name">
                {t("settings.tokens.plugin.nameLabel")}
              </Label>
              <Input
                id="new-import-token-name"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tokens.plugin.nameAutoHint", {
                  name: t("settings.tokens.plugin.autoName")
                })}
              </p>
              {nameTooLong ? (
                <p className="text-xs text-destructive">
                  {t("settings.tokens.common.nameTooLong")}
                </p>
              ) : null}
            </div>
            {createError ? (
              <p role="alert" className="text-xs text-destructive">
                {createError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || nameTooLong}
                onClick={() => void create()}
              >
                {busy
                  ? t("settings.tokens.plugin.creating")
                  : t("settings.tokens.plugin.create")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCreating(false)
                  setCreateError("")
                  setName("")
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        {tokens === null ? (
          <div className="space-y-2">
            {loadingError ? (
              <>
                <p role="alert" className="text-xs text-destructive">
                  {loadingError}
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
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.tokens.plugin.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    <span>
                      {t("settings.tokens.common.createdAt", {
                        time: formatDateTime(token.createdAt)
                      })}
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      {t("settings.tokens.common.lastUsed", {
                        time: token.lastUsedAt
                          ? formatDateTime(token.lastUsedAt)
                          : t("settings.tokens.common.neverUsed")
                      })}
                    </span>
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRevoking(token)}
                >
                  {t("settings.tokens.plugin.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tokens.plugin.revokeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tokens.plugin.revokeDescription", {
                name: revoking?.name ?? ""
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (revoking) void revoke(revoking)
              }}
            >
              {t("settings.tokens.plugin.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
