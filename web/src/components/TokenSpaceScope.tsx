import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type ApiTokenSpaces,
  describeApiError,
  type TokenSpaceIds
} from "@/lib/api"
import { useSpacesStore } from "@/stores/spaces"

type ScopeMode = "all" | "selected"

interface TokenSpaceScopeProps {
  /** 服务端当前范围：`null` = 不限制。 */
  spaceIds: TokenSpaceIds
  /** `PUT /me/{read,write}-token/spaces`：只改范围，不换令牌。 */
  save: (spaceIds: TokenSpaceIds) => Promise<ApiTokenSpaces>
  /** 保存成功后把新范围交回卡片，后续生成 / 重置沿用这个范围。 */
  onSaved: (spaceIds: TokenSpaceIds) => void
  disabled?: boolean
}

/** 两个范围相等：同为 `null`，或升序数组逐项相同。 */
function sameScope(a: TokenSpaceIds, b: TokenSpaceIds): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** 只保留当前可见的空间 id；列表未就绪时原样返回（别把选择清空）。 */
function keepVisible(
  ids: TokenSpaceIds,
  visible: ReadonlySet<number>
): TokenSpaceIds {
  if (ids === null) return null
  return ids.filter((id) => visible.has(id))
}

/**
 * 令牌的空间范围编辑（二期规格 §4）：全部空间 / 指定空间两态 + 勾选列表。
 *
 * 只改范围、不换令牌，所以它和生成 / 重置 / 吊销各自独立；范围行在令牌还没生成
 * 时也能存（服务端允许，生成时沿用）。空间列表复用 `useSpacesStore`（即会话接口
 * `GET /api/spaces`，站内已按成员资格过滤），不新开接口。
 *
 * 勾选与基线都按「当前可见空间」归一：主人退出或删除过的空间即使还留在范围里
 * （服务端留行是既有口径），也不会显示成幽灵勾选、更不会让保存被整单 400 拒掉。
 */
export function TokenSpaceScope({
  spaceIds,
  save,
  onSaved,
  disabled = false
}: TokenSpaceScopeProps) {
  const { t } = useTranslation()
  const spaces = useSpacesStore((state) => state.spaces)
  const spacesStatus = useSpacesStore((state) => state.status)
  const loadSpaces = useSpacesStore((state) => state.load)

  const [mode, setMode] = useState<ScopeMode>(
    spaceIds === null ? "all" : "selected"
  )
  const [picked, setPicked] = useState<number[]>(spaceIds ?? [])
  const [baseline, setBaseline] = useState<TokenSpaceIds>(spaceIds)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)

  // 外壳进入应用时已拉过空间列表；只有那次失败才在这里补一次，别发重复请求。
  useEffect(() => {
    if (spacesStatus === "error") void loadSpaces()
  }, [spacesStatus, loadSpaces])

  // 列表到得比状态晚（硬刷新直接落在设置页）：到齐后按可见空间归一一次。
  useEffect(() => {
    if (spacesStatus !== "ready") return
    const visible = new Set(spaces.map((space) => space.id))
    setPicked((prev) => prev.filter((id) => visible.has(id)))
    setBaseline((prev) => keepVisible(prev, visible))
  }, [spacesStatus, spaces])

  const next: TokenSpaceIds =
    mode === "all" ? null : [...picked].sort((a, b) => a - b)
  const dirty = !sameScope(next, baseline)
  const emptySelection = mode === "selected" && picked.length === 0
  const saveDisabled = saving || disabled || !dirty || emptySelection

  const submit = useCallback(async () => {
    setError("")
    setSaved(false)
    setSaving(true)
    try {
      const result = await save(next)
      const written = result.spaceIds
      setBaseline(written)
      setMode(written === null ? "all" : "selected")
      setPicked(written ?? [])
      onSaved(written)
      setSaved(true)
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }, [save, next, onSaved])

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {t("settings.tokens.scope.label")}
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          disabled={saving || disabled}
          aria-label={t("settings.tokens.scope.label")}
          onValueChange={(value) => {
            if (value !== "all" && value !== "selected") return
            setSaved(false)
            setError("")
            setMode(value)
          }}
        >
          <ToggleGroupItem value="all">
            {t("settings.tokens.scope.all")}
          </ToggleGroupItem>
          <ToggleGroupItem value="selected">
            {t("settings.tokens.scope.selected")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {mode === "selected" ? (
        spacesStatus === "ready" ? (
          spaces.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.tokens.scope.empty")}
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {spaces.map((space) => (
                <label
                  key={space.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={picked.includes(space.id)}
                    disabled={saving || disabled}
                    onCheckedChange={(checked) => {
                      setSaved(false)
                      setError("")
                      setPicked((prev) =>
                        checked === true
                          ? [...prev, space.id]
                          : prev.filter((id) => id !== space.id)
                      )
                    }}
                  />
                  <span className="min-w-0 truncate">{space.name}</span>
                </label>
              ))}
            </div>
          )
        ) : (
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        )
      ) : null}

      {mode === "selected" || dirty ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saveDisabled}
            onClick={() => void submit()}
          >
            {saving
              ? t("settings.tokens.scope.saving")
              : t("settings.tokens.scope.save")}
          </Button>
          {saved ? (
            <span
              role="status"
              className="text-xs text-emerald-700 dark:text-emerald-300"
            >
              {t("settings.tokens.scope.saved")}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
