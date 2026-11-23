import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  ApiError,
  type AgentAccount,
  type AgentSpaceItem,
  type SpaceRole,
  describeApiError,
  meApi
} from "@/lib/api"

export interface AgentSpacesDialogProps {
  agent: AgentAccount | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ROLE_OPTIONS: SpaceRole[] = ["admin", "editor", "viewer"]

export function AgentSpacesDialog({
  agent,
  open,
  onOpenChange
}: AgentSpacesDialogProps) {
  const { t } = useTranslation()

  const [spaces, setSpaces] = useState<AgentSpaceItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [successNotice, setSuccessNotice] = useState("")
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [batchRole, setBatchRole] = useState<SpaceRole>("editor")
  const [submitting, setSubmitting] = useState(false)
  const [removingSpaceId, setRemovingSpaceId] = useState<number | null>(null)
  const [batchErrors, setBatchErrors] = useState<
    Array<{ spaceId: number; spaceName: string; message: string }>
  >([])

  const loadSpaces = useCallback(async (agentId: number) => {
    setLoading(true)
    setError("")
    try {
      const data = await meApi.agents.spaces(agentId)
      setSpaces(data)
    } catch (err) {
      setSpaces(null)
      setError(describeApiError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && agent) {
      setSelectedIds([])
      setError("")
      setSuccessNotice("")
      setBatchErrors([])
      setBatchRole("editor")
      void loadSpaces(agent.id)
    } else {
      setSpaces(null)
    }
  }, [open, agent, loadSpaces])

  if (!agent) return null

  const allSelected =
    spaces !== null && spaces.length > 0 && selectedIds.length === spaces.length

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([])
    } else {
      setSelectedIds((spaces ?? []).map((s) => s.spaceId))
    }
  }

  const toggleSelect = (spaceId: number) => {
    setSelectedIds((prev) =>
      prev.includes(spaceId)
        ? prev.filter((id) => id !== spaceId)
        : [...prev, spaceId]
    )
  }

  const handleBatchSubmit = async () => {
    if (selectedIds.length === 0 || submitting) return
    setSubmitting(true)
    setError("")
    setSuccessNotice("")
    setBatchErrors([])
    try {
      const res = await meApi.agents.setSpaces(agent.id, {
        spaceIds: selectedIds,
        role: batchRole
      })
      const spaceMap = new Map((spaces ?? []).map((s) => [s.spaceId, s.name]))
      const failures: Array<{
        spaceId: number
        spaceName: string
        message: string
      }> = []
      let successCount = 0

      for (const item of res.results) {
        if (item.ok) {
          successCount++
        } else {
          const sName = spaceMap.get(item.spaceId) || `#${item.spaceId}`
          let msg = item.error
          if (item.code === "LAST_SPACE_ADMIN") {
            msg = t("settings.agents.spaces.errors.lastAdmin")
          } else if (item.code === "SPACE_FORBIDDEN") {
            msg = t("settings.agents.spaces.errors.forbidden")
          } else if (item.code === "SPACE_NOT_FOUND") {
            msg = t("settings.agents.spaces.errors.notFound")
          } else if (item.code === "USER_NOT_ELIGIBLE") {
            msg = t("settings.agents.spaces.errors.notEligible")
          }
          failures.push({
            spaceId: item.spaceId,
            spaceName: sName,
            message: msg
          })
        }
      }

      if (successCount > 0) {
        setSuccessNotice(
          t("settings.agents.spaces.batchSuccess", { count: successCount })
        )
      }
      if (failures.length > 0) {
        setBatchErrors(failures)
        setSelectedIds(failures.map((f) => f.spaceId))
      } else {
        setSelectedIds([])
      }

      const updatedList = await meApi.agents.spaces(agent.id)
      setSpaces(updatedList)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRemove = async (space: AgentSpaceItem) => {
    if (removingSpaceId !== null) return
    setRemovingSpaceId(space.spaceId)
    setError("")
    setSuccessNotice("")
    setBatchErrors([])
    try {
      await meApi.agents.removeSpace(agent.id, space.spaceId)
      setSuccessNotice(
        t("settings.agents.spaces.removeSuccess", { name: space.name })
      )
      const updatedList = await meApi.agents.spaces(agent.id)
      setSpaces(updatedList)
    } catch (err) {
      if (err instanceof ApiError && err.code === "LAST_SPACE_ADMIN") {
        setError(t("settings.agents.spaces.errors.lastAdmin"))
      } else {
        setError(describeApiError(err))
      }
    } finally {
      setRemovingSpaceId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("settings.agents.spaces.title", { name: agent.username })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.agents.spaces.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {successNotice ? (
            <p
              role="status"
              className="text-xs text-emerald-700 dark:text-emerald-300"
            >
              {successNotice}
            </p>
          ) : null}

          {batchErrors.length > 0 ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive space-y-1"
            >
              <p className="font-medium">
                {t("settings.agents.spaces.batchPartialError")}
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                {batchErrors.map((err) => (
                  <li key={err.spaceId}>
                    {`${err.spaceName}：${err.message}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {loading ? (
            <p className="text-xs text-muted-foreground">
              {t("common.loading")}
            </p>
          ) : spaces === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadSpaces(agent.id)}
            >
              {t("common.retry")}
            </Button>
          ) : spaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("settings.agents.spaces.empty")}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-border">
                <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={allSelected}
                      aria-label="Select all spaces"
                      onCheckedChange={toggleSelectAll}
                    />
                    <span>{t("settings.agents.spaces.columnSpace")}</span>
                  </div>
                  <div className="flex items-center gap-8">
                    <span>{t("settings.agents.spaces.columnRole")}</span>
                    <span className="w-12 text-right">
                      {t("settings.agents.spaces.columnActions")}
                    </span>
                  </div>
                </div>

                <ul className="divide-y divide-border">
                  {spaces.map((space) => {
                    const isChecked = selectedIds.includes(space.spaceId)
                    const isRemoving = removingSpaceId === space.spaceId

                    return (
                      <li
                        key={space.spaceId}
                        className="flex items-center justify-between px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={isChecked}
                            aria-label={`Select ${space.name}`}
                            onCheckedChange={() => toggleSelect(space.spaceId)}
                          />
                          <span className="font-medium">{space.name}</span>
                          <span className="text-[11px] text-muted-foreground">
                            ({space.slug})
                          </span>
                        </div>

                        <div className="flex items-center gap-6">
                          <div>
                            {space.role ? (
                              <Badge
                                variant={
                                  space.role === "admin"
                                    ? "default"
                                    : "secondary"
                                }
                                className="text-[10px]"
                              >
                                {t(`common.roles.${space.role}`)}
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[10px] text-muted-foreground"
                              >
                                {t("settings.agents.spaces.notJoined")}
                              </Badge>
                            )}
                          </div>

                          <div className="w-12 text-right">
                            {space.role ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="text-destructive hover:text-destructive h-6 px-1.5"
                                disabled={submitting || isRemoving}
                                onClick={() => void handleRemove(space)}
                              >
                                {t("settings.agents.spaces.remove")}
                              </Button>
                            ) : (
                              <span className="text-muted-foreground text-[11px]">
                                -
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>

              {/* 批量操作工具栏 */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/20 p-2.5">
                <span className="text-xs text-muted-foreground">
                  {t("settings.agents.spaces.selectedCount", {
                    count: selectedIds.length
                  })}
                </span>

                <div className="flex items-center gap-2">
                  <Select
                    value={batchRole}
                    disabled={submitting || selectedIds.length === 0}
                    onValueChange={(val) => setBatchRole(val as SpaceRole)}
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((r) => (
                        <SelectItem key={r} value={r} className="text-xs">
                          {t(`common.roles.${r}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    type="button"
                    size="xs"
                    disabled={submitting || selectedIds.length === 0}
                    onClick={() => void handleBatchSubmit()}
                  >
                    {submitting
                      ? t("settings.agents.spaces.applying")
                      : t("settings.agents.spaces.applyRole")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
