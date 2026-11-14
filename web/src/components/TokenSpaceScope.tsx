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
  /** 当前（或草稿初始）范围：`null` = 不限制。 */
  spaceIds: TokenSpaceIds
  /**
   * `PUT /me/tokens/:id/spaces`：只改范围，不换令牌。
   * 不传即为「草稿态」——新建面的编辑，范围由 `onChange` 交回调用方。
   */
  save?: (spaceIds: TokenSpaceIds) => Promise<ApiTokenSpaces>
  /** 保存成功后把写入的范围交回卡片，后续操作沿用这个范围。 */
  onSaved?: (spaceIds: TokenSpaceIds) => void
  /** 草稿态专用：范围每变一次交回 `null | 升序数组`（可能为空数组）。 */
  onChange?: (spaceIds: TokenSpaceIds) => void
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

/** 勾选项的规范形态：去重后升序（契约里的范围数组就是这么排的）。 */
function normalize(picked: number[]): number[] {
  return [...new Set(picked)].sort((a, b) => a - b)
}

/**
 * 令牌的空间范围编辑（二期规格 §4，三期 §5 复用）：全部空间 / 指定空间两态 + 勾选列表。
 *
 * 两种用法共用同一套控件，不另造一份：
 * - 保存态（传 `save`）：只改范围、不换令牌，自带「保存范围」行；新令牌还没建时
 *   也能存（服务端允许，生成时沿用）。
 * - 草稿态（不传 `save`，用 `onChange`）：新建面里先把范围编辑好，随创建请求一起发，
 *   此时没有「保存」这一步，也不显示成功/失败行。
 *
 * 空间列表复用 `useSpacesStore`（即会话接口 `GET /api/spaces`，站内已按成员资格过滤），
 * 不新开接口。勾选与基线都按「当前可见空间」归一：主人退出或删除过的空间即使还留在
 * 范围里（服务端留行是既有口径），也不会显示成幽灵勾选、更不会让保存被整单 400 拒掉。
 */
export function TokenSpaceScope({
  spaceIds,
  save,
  onSaved,
  onChange,
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

  const draft = save === undefined

  // 外壳进入应用时已拉过空间列表；只有那次失败才在这里补一次，别发重复请求。
  useEffect(() => {
    if (spacesStatus === "error") void loadSpaces()
  }, [spacesStatus, loadSpaces])

  // 列表到得比状态晚（硬刷新直接落在设置页）：到齐后按可见空间归一一次。
  useEffect(() => {
    if (spacesStatus !== "ready") return
    const visible = new Set(spaces.map((space) => space.id))
    const kept = picked.filter((id) => visible.has(id))
    if (kept.length !== picked.length) {
      setPicked(kept)
      // 草稿态没有「保存」那一步，归一结果要立刻交回调用方
      if (draft) onChange?.(mode === "all" ? null : normalize(kept))
    }
    if (baseline?.some((id) => !visible.has(id))) {
      setBaseline(keepVisible(baseline, visible))
    }
  }, [spacesStatus, spaces, picked, baseline, mode, draft, onChange])

  const next: TokenSpaceIds = mode === "all" ? null : normalize(picked)
  const dirty = !sameScope(next, baseline)
  const emptySelection = mode === "selected" && picked.length === 0
  const saveDisabled = saving || disabled || !dirty || emptySelection

  /** 草稿态的范围每次都交回调用方；保存态交给「保存范围」按钮。 */
  const change = (nextMode: ScopeMode, nextPicked: number[]) => {
    setSaved(false)
    setError("")
    setMode(nextMode)
    setPicked(nextPicked)
    if (draft) onChange?.(nextMode === "all" ? null : normalize(nextPicked))
  }

  const submit = useCallback(async () => {
    if (!save) return
    setError("")
    setSaved(false)
    setSaving(true)
    try {
      const result = await save(next)
      const written = result.spaceIds
      setBaseline(written)
      setMode(written === null ? "all" : "selected")
      setPicked(written ?? [])
      onSaved?.(written)
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
            change(value, picked)
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
                    onCheckedChange={(checked) =>
                      change(
                        mode,
                        checked === true
                          ? [...picked, space.id]
                          : picked.filter((id) => id !== space.id)
                      )
                    }
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

      {!draft && (mode === "selected" || dirty) ? (
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

      {!draft && error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
