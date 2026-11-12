import { Check, Copy, KeySquare, Plus } from "lucide-react"
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  ApiError,
  type ApiTokenKind,
  type ApiTokenSummary,
  describeApiError,
  meApi,
  type TokenSpaceIds
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

/** 名称上限（契约：trim 后 ≤40 码点）。 */
const NAME_MAX = 40

const KIND_KEYS: Record<ApiTokenKind, string> = {
  read: "settings.tokens.api.kind.read",
  write: "settings.tokens.api.kind.write"
}

const AUTO_NAME_KEYS: Record<ApiTokenKind, string> = {
  read: "settings.tokens.api.autoName.read",
  write: "settings.tokens.api.autoName.write"
}

/** 按码点数长度：`[...name]` 把 emoji 这类代理对算一个字，与契约一致。 */
function nameLength(name: string): number {
  return [...name].length
}

/**
 * 「API Token」卡（接口三期 §5）：多条令牌的列表 + 新建 / 改名 / 改范围 / 吊销。
 *
 * 明文只在创建那一次出现（服务端只存哈希），之后列表只回名称、类型、范围与时间；
 * 类型创建后固定，所以只有新建面提供类型切换，列表里只读展示。
 * 列表顺序直接用服务端给的 created_at 升序，不在前端重排。
 */
export function ApiTokensCard() {
  const { t } = useTranslation()

  const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null)
  const [loadingError, setLoadingError] = useState("")
  const [error, setError] = useState("")
  /** 成功提示存 key，渲染时再 t()：切语言后提示跟着变。 */
  const [noticeKey, setNoticeKey] = useState("")
  const [issued, setIssued] = useState("")
  /** 明文属于哪一条：吊销别的令牌时不能把还没保存的明文一起清掉。 */
  const [issuedId, setIssuedId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  // 新建面
  const [creating, setCreating] = useState(false)
  const [kind, setKind] = useState<ApiTokenKind>("read")
  const [name, setName] = useState("")
  const [draftScope, setDraftScope] = useState<TokenSpaceIds>(null)
  const [createError, setCreateError] = useState("")

  // 改名 / 改范围 / 吊销
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(
    null
  )
  const [renameError, setRenameError] = useState("")
  const [scopeFor, setScopeFor] = useState<number | null>(null)
  const [revoking, setRevoking] = useState<ApiTokenSummary | null>(null)

  const load = useCallback(async () => {
    setLoadingError("")
    try {
      setTokens((await meApi.tokens()).tokens)
    } catch (loadError) {
      setTokens(null)
      setLoadingError(describeApiError(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const trimmedName = name.trim()
  const createNameTooLong = nameLength(trimmedName) > NAME_MAX
  const draftEmpty = draftScope !== null && draftScope.length === 0
  const createDisabled = busy || createNameTooLong || draftEmpty

  const create = async () => {
    if (createDisabled) return
    setCreateError("")
    setNoticeKey("")
    setCopied(false)
    setBusy(true)
    try {
      const result = await meApi.createToken({
        kind,
        // 留空就不带这个键：自动名以服务端落的为准，前端不自己编
        ...(trimmedName ? { name: trimmedName } : {}),
        spaceIds: draftScope
      })
      setIssued(result.token)
      setIssuedId(result.id)
      setCreating(false)
      setKind("read")
      setName("")
      setDraftScope(null)
      setNoticeKey("settings.tokens.api.created")
      await load()
    } catch (createFailure) {
      setCreateError(describeApiError(createFailure))
    } finally {
      setBusy(false)
    }
  }

  /** 令牌在别处被吊销后所有行操作都回 404：当作「已不在列表里」，重拉即可。 */
  const treatMissing = async () => {
    setRenaming(null)
    setScopeFor(null)
    setNoticeKey("settings.tokens.api.missing")
    await load()
  }

  const submitRename = async () => {
    if (!renaming || busy) return
    const next = renaming.name.trim()
    if (!next || nameLength(next) > NAME_MAX) return
    setRenameError("")
    setBusy(true)
    try {
      await meApi.renameToken(renaming.id, next)
      setRenaming(null)
      setNoticeKey("settings.tokens.api.renamed")
      await load()
    } catch (renameFailure) {
      if (renameFailure instanceof ApiError && renameFailure.status === 404) {
        await treatMissing()
      } else {
        setRenameError(describeApiError(renameFailure))
      }
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (token: ApiTokenSummary) => {
    setError("")
    setNoticeKey("")
    setRevoking(null)
    setBusy(true)
    try {
      await meApi.revokeToken(token.id)
      // 只清掉这条自己刚生成的明文，别的令牌的明文还得让用户复制走
      if (issuedId === token.id) {
        setIssued("")
        setIssuedId(null)
        setCopied(false)
      }
      if (scopeFor === token.id) setScopeFor(null)
      setNoticeKey("settings.tokens.api.revoked")
      await load()
    } catch (revokeFailure) {
      // 契约里「非本人 / 已吊销」都是 404：重拉列表即可，不必让用户再点一次
      if (revokeFailure instanceof ApiError && revokeFailure.status === 404) {
        await treatMissing()
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

  const renameTooLong = renaming
    ? nameLength(renaming.name.trim()) > NAME_MAX
    : false

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeySquare
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("settings.tokens.api.title")}
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
            {t("settings.tokens.api.new")}
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
              {t("settings.tokens.api.issuedHint")}
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
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t("settings.tokens.api.kindLabel")}
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={kind}
                disabled={busy}
                aria-label={t("settings.tokens.api.kindLabel")}
                onValueChange={(value) => {
                  if (value === "read" || value === "write") setKind(value)
                }}
              >
                <ToggleGroupItem value="read">
                  {t("settings.tokens.api.kind.read")}
                </ToggleGroupItem>
                <ToggleGroupItem value="write">
                  {t("settings.tokens.api.kind.write")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-token-name">
                {t("settings.tokens.api.nameLabel")}
              </Label>
              <Input
                id="new-token-name"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.tokens.api.nameAutoHint", {
                  name: t(AUTO_NAME_KEYS[kind])
                })}
              </p>
              {createNameTooLong ? (
                <p className="text-xs text-destructive">
                  {t("settings.tokens.common.nameTooLong")}
                </p>
              ) : null}
            </div>
            <TokenSpaceScope
              spaceIds={draftScope}
              onChange={setDraftScope}
              disabled={busy}
            />
            {createError ? (
              <p role="alert" className="text-xs text-destructive">
                {createError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={createDisabled}
                onClick={() => void create()}
              >
                {busy
                  ? t("settings.tokens.api.creating")
                  : t("settings.tokens.api.create")}
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
                  setKind("read")
                  setDraftScope(null)
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
            {t("settings.tokens.api.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((token) => (
              <li key={token.id} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {token.name}
                      </span>
                      <Badge variant="secondary">
                        {t(KIND_KEYS[token.kind])}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      <span>
                        {token.spaceIds === null
                          ? t("settings.tokens.scope.summary.all")
                          : t("settings.tokens.scope.summary.selected", {
                              count: token.spaceIds.length
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
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setRenameError("")
                        setRenaming({ id: token.id, name: token.name })
                      }}
                    >
                      {t("settings.tokens.api.rename")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      aria-expanded={scopeFor === token.id}
                      onClick={() =>
                        setScopeFor(scopeFor === token.id ? null : token.id)
                      }
                    >
                      {t("settings.tokens.api.editScope")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRevoking(token)}
                    >
                      {t("settings.tokens.api.revoke")}
                    </Button>
                  </div>
                </div>

                {scopeFor === token.id ? (
                  <TokenSpaceScope
                    spaceIds={token.spaceIds}
                    disabled={busy}
                    save={async (spaceIds) => {
                      try {
                        await meApi.setTokenSpaces(token.id, spaceIds)
                      } catch (scopeFailure) {
                        if (
                          scopeFailure instanceof ApiError &&
                          scopeFailure.status === 404
                        ) {
                          await treatMissing()
                        }
                        throw scopeFailure
                      }
                      // 回执形状 §3 未规定：把归一后的请求值交回控件，真实值以重拉为准
                      return { spaceIds }
                    }}
                    onSaved={() => {
                      setNoticeKey("")
                      void load()
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (open) return
          setRenaming(null)
          setRenameError("")
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("settings.tokens.api.renameTitle")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="token-name">
                {t("settings.tokens.api.nameLabel")}
              </Label>
              <Input
                id="token-name"
                value={renaming?.name ?? ""}
                autoComplete="off"
                onChange={(event) =>
                  setRenaming((previous) =>
                    previous
                      ? { ...previous, name: event.target.value }
                      : previous
                  )
                }
              />
              {renameTooLong ? (
                <p className="text-xs text-destructive">
                  {t("settings.tokens.common.nameTooLong")}
                </p>
              ) : null}
            </div>
            {renameError ? (
              <p role="alert" className="text-xs text-destructive">
                {renameError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !renaming?.name.trim() || renameTooLong}
              >
                {t("settings.tokens.api.renameConfirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tokens.api.revokeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tokens.api.revokeDescription", {
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
              {t("settings.tokens.api.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
