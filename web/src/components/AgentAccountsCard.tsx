import { Bot, Check, ChevronDown, ChevronUp, Copy, Plus } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type AgentAccount,
  type ApiTokenCreated,
  type ApiTokenKind,
  type ApiTokenSummary,
  describeApiError,
  meApi,
  type TokenSpaceIds
} from "@/lib/api"
import { formatDate, formatDateTime } from "@/lib/format"
import { buildIntegrationPrompt } from "@/lib/token-prompt"
import { useSpacesStore } from "@/stores/spaces"

const NAME_MAX = 40

const KIND_KEYS: Record<ApiTokenKind, string> = {
  read: "settings.tokens.api.kind.read",
  write: "settings.tokens.api.kind.write"
}

const AUTO_NAME_KEYS: Record<ApiTokenKind, string> = {
  read: "settings.tokens.api.autoName.read",
  write: "settings.tokens.api.autoName.write"
}

function nameLength(name: string): number {
  return [...name].length
}

interface IssuedAgentToken extends ApiTokenCreated {
  agentId: number
}

export function AgentAccountsCard() {
  const { t, i18n } = useTranslation()
  const spaces = useSpacesStore((s) => s.spaces)

  const [agents, setAgents] = useState<AgentAccount[] | null>(null)
  const [loadingError, setLoadingError] = useState("")
  const [error, setError] = useState("")
  const [noticeKey, setNoticeKey] = useState("")
  const [busy, setBusy] = useState(false)

  // 新建 Agent
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState("")
  const [createError, setCreateError] = useState("")

  // 删除 Agent
  const [deleteTargetAgent, setDeleteTargetAgent] =
    useState<AgentAccount | null>(null)

  // 令牌代管展开展平状态
  const [expandedAgentId, setExpandedAgentId] = useState<number | null>(null)
  const [tokensMap, setTokensMap] = useState<Record<number, ApiTokenSummary[]>>(
    {}
  )
  const [tokensLoading, setTokensLoading] = useState<Record<number, boolean>>(
    {}
  )
  const [tokensError, setTokensError] = useState<Record<number, string>>({})

  // 签发代管 Token
  const [issuingAgentId, setIssuingAgentId] = useState<number | null>(null)
  const [tokenKind, setTokenKind] = useState<ApiTokenKind>("read")
  const [tokenName, setTokenName] = useState("")
  const [draftScope, setDraftScope] = useState<TokenSpaceIds>(null)
  const [issueError, setIssueError] = useState("")

  // 刚签发的明文显示
  const [issuedToken, setIssuedToken] = useState<IssuedAgentToken | null>(null)
  const [copiedToken, setCopiedToken] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  // 吊销代管 Token
  const [revokingToken, setRevokingToken] = useState<{
    agentId: number
    token: ApiTokenSummary
  } | null>(null)

  const loadAgents = useCallback(async () => {
    setLoadingError("")
    try {
      const data = await meApi.agents.list()
      setAgents(data)
    } catch (loadErr) {
      setAgents(null)
      setLoadingError(describeApiError(loadErr))
    }
  }, [])

  useEffect(() => {
    void loadAgents()
  }, [loadAgents])

  const loadTokens = useCallback(async (agentId: number) => {
    setTokensLoading((prev) => ({ ...prev, [agentId]: true }))
    setTokensError((prev) => ({ ...prev, [agentId]: "" }))
    try {
      const res = await meApi.agents.tokens(agentId)
      setTokensMap((prev) => ({ ...prev, [agentId]: res.tokens }))
    } catch (err) {
      setTokensError((prev) => ({ ...prev, [agentId]: describeApiError(err) }))
    } finally {
      setTokensLoading((prev) => ({ ...prev, [agentId]: false }))
    }
  }, [])

  const toggleExpand = (agentId: number) => {
    if (expandedAgentId === agentId) {
      setExpandedAgentId(null)
    } else {
      setExpandedAgentId(agentId)
      if (!tokensMap[agentId]) {
        void loadTokens(agentId)
      }
    }
  }

  const trimmedUsername = newUsername.trim()
  const usernameTooLong = nameLength(trimmedUsername) > NAME_MAX

  const createAgent = async () => {
    if (!trimmedUsername) {
      setCreateError(t("profile.emptyUsername"))
      return
    }
    if (usernameTooLong || busy) return
    setCreateError("")
    setNoticeKey("")
    setBusy(true)
    try {
      const created = await meApi.agents.create({ username: trimmedUsername })
      setAgents((prev) => (prev ? [...prev, created] : [created]))
      setNewUsername("")
      setCreating(false)
      setNoticeKey("settings.agents.created")
    } catch (createFailure) {
      setCreateError(describeApiError(createFailure))
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (agent: AgentAccount, nextActive: boolean) => {
    if (busy) return
    setError("")
    setNoticeKey("")
    setBusy(true)
    try {
      const updated = await meApi.agents.update(agent.id, {
        isActive: nextActive
      })
      setAgents((prev) =>
        prev ? prev.map((a) => (a.id === agent.id ? updated : a)) : prev
      )
      setNoticeKey("settings.agents.statusUpdated")
    } catch (toggleError) {
      setError(describeApiError(toggleError))
    } finally {
      setBusy(false)
    }
  }

  const deleteAgent = async (agentId: number) => {
    if (busy) return
    setError("")
    setNoticeKey("")
    setBusy(true)
    try {
      await meApi.agents.delete(agentId)
      setAgents((prev) => (prev ? prev.filter((a) => a.id !== agentId) : prev))
      if (expandedAgentId === agentId) {
        setExpandedAgentId(null)
      }
      if (issuedToken?.agentId === agentId) {
        setIssuedToken(null)
      }
      setNoticeKey("settings.agents.deleted")
      setDeleteTargetAgent(null)
    } catch (deleteError) {
      setError(describeApiError(deleteError))
    } finally {
      setBusy(false)
    }
  }

  const trimmedTokenName = tokenName.trim()
  const tokenNameTooLong = nameLength(trimmedTokenName) > NAME_MAX
  const draftEmpty = draftScope !== null && draftScope.length === 0
  const issueDisabled = busy || tokenNameTooLong || draftEmpty

  const issueToken = async (agentId: number) => {
    if (issueDisabled) return
    setIssueError("")
    setNoticeKey("")
    setCopiedToken(false)
    setCopiedPrompt(false)
    setBusy(true)
    try {
      const res = await meApi.agents.issueToken(agentId, {
        kind: tokenKind,
        name: trimmedTokenName || undefined,
        spaceIds: draftScope
      })
      setIssuedToken({
        ...res,
        agentId
      })
      setNoticeKey("settings.agents.tokens.issued")
      setIssuingAgentId(null)
      setTokenName("")
      setDraftScope(null)
      await loadTokens(agentId)
    } catch (issueFailure) {
      setIssueError(describeApiError(issueFailure))
    } finally {
      setBusy(false)
    }
  }

  const revokeToken = async (agentId: number, tokenId: number) => {
    if (busy) return
    setError("")
    setNoticeKey("")
    setBusy(true)
    try {
      await meApi.agents.revokeToken(agentId, tokenId)
      if (issuedToken?.id === tokenId) {
        setIssuedToken(null)
      }
      setTokensMap((prev) => ({
        ...prev,
        [agentId]: prev[agentId]
          ? prev[agentId].filter((tok) => tok.id !== tokenId)
          : []
      }))
      setNoticeKey("settings.agents.tokens.revoked")
      setRevokingToken(null)
    } catch (revokeFailure) {
      setError(describeApiError(revokeFailure))
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (text: string, type: "token" | "prompt") => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === "token") {
        setCopiedToken(true)
        window.setTimeout(() => setCopiedToken(false), 1600)
      } else {
        setCopiedPrompt(true)
        window.setTimeout(() => setCopiedPrompt(false), 1600)
      }
    } catch {
      setError(t("settings.tokens.common.copyFailed"))
    }
  }

  const copyIntegrationPrompt = async (tokenInfo: IssuedAgentToken) => {
    const prompt = buildIntegrationPrompt({
      lang: i18n.language,
      kind: tokenInfo.kind,
      spaceIds: tokenInfo.spaceIds,
      spaces
    })
    await copyText(prompt, "prompt")
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("settings.agents.title")}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            disabled={busy || creating}
            aria-expanded={creating}
            onClick={() => {
              setCreating(true)
              setNewUsername("")
              setCreateError("")
              setNoticeKey("")
            }}
          >
            <Plus aria-hidden="true" />
            {t("settings.agents.new")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {creating ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor="agent-new-username" className="text-xs">
                {t("settings.agents.usernameLabel")}
              </Label>
              <Input
                id="agent-new-username"
                value={newUsername}
                disabled={busy}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t("settings.agents.usernamePlaceholder")}
              />
              {usernameTooLong ? (
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

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || usernameTooLong || !trimmedUsername}
                onClick={() => void createAgent()}
              >
                {t("settings.agents.create")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCreating(false)
                  setCreateError("")
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        {agents === null ? (
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
                  onClick={() => void loadAgents()}
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
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.agents.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const isExpanded = expandedAgentId === agent.id
              const agentTokens = tokensMap[agent.id] ?? []
              const isLoadingTokens = Boolean(tokensLoading[agent.id])
              const tokErr = tokensError[agent.id]
              const showPlaintext =
                issuedToken !== null && issuedToken.agentId === agent.id

              return (
                <li key={agent.id} className="space-y-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Bot className="size-4" aria-hidden="true" />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm">
                            {agent.username}
                          </span>
                          <Badge variant="secondary" className="text-[10px]">
                            Agent
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {formatDate(agent.createdAt)}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          size="sm"
                          checked={agent.isActive}
                          disabled={busy}
                          aria-label={t("settings.agents.statusToggle", {
                            name: agent.username
                          })}
                          onCheckedChange={(checked) =>
                            void toggleActive(agent, checked)
                          }
                        />
                        <span className="text-xs text-muted-foreground">
                          {agent.isActive
                            ? t("settings.agents.statusActive")
                            : t("settings.agents.statusInactive")}
                        </span>
                      </div>

                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={isExpanded}
                        onClick={() => toggleExpand(agent.id)}
                      >
                        {isExpanded ? (
                          <>
                            {t("settings.agents.tokens.collapse")}
                            <ChevronUp
                              className="size-3.5"
                              aria-hidden="true"
                            />
                          </>
                        ) : (
                          <>
                            {t("settings.agents.tokens.expand")}
                            <ChevronDown
                              className="size-3.5"
                              aria-hidden="true"
                            />
                          </>
                        )}
                      </Button>

                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setDeleteTargetAgent(agent)}
                      >
                        {t("settings.agents.delete")}
                      </Button>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="ml-2 space-y-3 rounded-lg border border-border/80 bg-muted/20 p-3 sm:ml-10">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="font-medium text-xs text-muted-foreground">
                          {t("settings.agents.tokens.title")}
                        </h4>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy || issuingAgentId === agent.id}
                          onClick={() => {
                            setIssuingAgentId(agent.id)
                            setTokenKind("read")
                            setTokenName("")
                            setDraftScope(null)
                            setIssueError("")
                          }}
                        >
                          <Plus className="size-3" aria-hidden="true" />
                          {t("settings.agents.tokens.new")}
                        </Button>
                      </div>

                      {showPlaintext && issuedToken ? (
                        <div className="space-y-2 rounded-md border border-border bg-background p-3">
                          <p className="text-xs text-muted-foreground">
                            {t("settings.tokens.api.issuedHint")}
                          </p>
                          <p className="font-mono text-xs break-all select-all rounded bg-muted p-2">
                            {issuedToken.token}
                          </p>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={
                                  copiedToken
                                    ? t("settings.tokens.common.copied")
                                    : t("settings.tokens.common.copyLabel")
                                }
                                onClick={() =>
                                  void copyText(issuedToken.token, "token")
                                }
                              >
                                {copiedToken ? (
                                  <Check
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Copy
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                )}
                                {copiedToken
                                  ? t("settings.tokens.common.copied")
                                  : t("settings.tokens.common.copy")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={
                                  copiedPrompt
                                    ? t("settings.tokens.common.copied")
                                    : t("settings.tokens.api.copyPromptLabel")
                                }
                                onClick={() =>
                                  void copyIntegrationPrompt(issuedToken)
                                }
                              >
                                {copiedPrompt ? (
                                  <Check
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Copy
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                )}
                                {copiedPrompt
                                  ? t("settings.tokens.common.copied")
                                  : t("settings.tokens.api.copyPrompt")}
                              </Button>
                            </div>
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              onClick={() => {
                                setIssuedToken(null)
                                setCopiedToken(false)
                                setCopiedPrompt(false)
                              }}
                            >
                              {t("settings.tokens.common.saved")}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {issuingAgentId === agent.id ? (
                        <div className="space-y-3 rounded-md border border-border bg-background p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium">
                              {t("settings.agents.tokens.kindLabel")}
                            </span>
                            <ToggleGroup
                              type="single"
                              variant="outline"
                              size="sm"
                              value={tokenKind}
                              disabled={busy}
                              aria-label={t("settings.agents.tokens.kindLabel")}
                              onValueChange={(val) => {
                                if (val === "read" || val === "write") {
                                  setTokenKind(val)
                                }
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

                          <div className="space-y-1">
                            <Label
                              htmlFor={`agent-token-name-${agent.id}`}
                              className="text-xs"
                            >
                              {t("settings.agents.tokens.nameLabel")}
                            </Label>
                            <Input
                              id={`agent-token-name-${agent.id}`}
                              value={tokenName}
                              disabled={busy}
                              onChange={(e) => setTokenName(e.target.value)}
                              placeholder={t(AUTO_NAME_KEYS[tokenKind])}
                              aria-describedby={`agent-token-hint-${agent.id}`}
                            />
                            <p
                              id={`agent-token-hint-${agent.id}`}
                              className="text-[11px] text-muted-foreground"
                            >
                              {t("settings.agents.tokens.nameAutoHint", {
                                name: t(AUTO_NAME_KEYS[tokenKind])
                              })}
                            </p>
                            {tokenNameTooLong ? (
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

                          {issueError ? (
                            <p
                              role="alert"
                              className="text-xs text-destructive"
                            >
                              {issueError}
                            </p>
                          ) : null}

                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={issueDisabled}
                              onClick={() => void issueToken(agent.id)}
                            >
                              {t("settings.agents.tokens.issue")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => {
                                setIssuingAgentId(null)
                                setIssueError("")
                              }}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {isLoadingTokens ? (
                        <p className="text-xs text-muted-foreground">
                          {t("settings.tokens.common.loading")}
                        </p>
                      ) : tokErr ? (
                        <div className="space-y-1">
                          <p role="alert" className="text-xs text-destructive">
                            {tokErr}
                          </p>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => void loadTokens(agent.id)}
                          >
                            {t("common.retry")}
                          </Button>
                        </div>
                      ) : agentTokens.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("settings.agents.tokens.empty")}
                        </p>
                      ) : (
                        <ul className="divide-y divide-border rounded-md border border-border bg-background">
                          {agentTokens.map((token) => (
                            <li
                              key={token.id}
                              className="flex flex-wrap items-center justify-between gap-2 p-2.5"
                            >
                              <div className="min-w-0 space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-medium text-xs">
                                    {token.name}
                                  </span>
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px]"
                                  >
                                    {t(KIND_KEYS[token.kind])}
                                  </Badge>
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  <span>
                                    {token.spaceIds === null
                                      ? t("settings.tokens.scope.summary.all")
                                      : t(
                                          "settings.tokens.scope.summary.selected",
                                          { count: token.spaceIds.length }
                                        )}
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
                                className="text-destructive hover:text-destructive"
                                disabled={busy}
                                onClick={() =>
                                  setRevokingToken({
                                    agentId: agent.id,
                                    token
                                  })
                                }
                              >
                                {t("settings.agents.tokens.revoke")}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={deleteTargetAgent !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetAgent(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.agents.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetAgent
                ? t("settings.agents.deleteDescription", {
                    name: deleteTargetAgent.username
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={() => {
                if (deleteTargetAgent) void deleteAgent(deleteTargetAgent.id)
              }}
            >
              {t("settings.agents.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={revokingToken !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingToken(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.agents.tokens.revokeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revokingToken
                ? t("settings.agents.tokens.revokeDescription", {
                    name: revokingToken.token.name
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={() => {
                if (revokingToken) {
                  void revokeToken(
                    revokingToken.agentId,
                    revokingToken.token.id
                  )
                }
              }}
            >
              {t("settings.agents.tokens.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
