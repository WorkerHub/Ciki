import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { describeApiError, type PageNode, pagesApi } from "@/lib/api"
import { editableSpaces } from "@/lib/space"
import { findNode, flattenAll, INDENT_WIDTH, withoutSubtree } from "@/lib/tree"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 「顶层（无父页面）」的 Select value；数字 id 只在控件边界转换。 */
const TOP_LEVEL = "0"

/**
 * 移动页面：目标空间 + 目标空间内的父页面。
 * 打开时默认目标空间 = 页面当前所在空间、父页 = 页面现父页（跨空间时是顶层）；
 * 目标空间切走以后父页一律回到顶层，与之前的跨空间行为一致。
 * 落位是目标父页子列表的末尾（与建页同口径），走 `POST /pages/:id/move`。
 */
export function MovePageDialog({
  pageId,
  pageTitle,
  parentId,
  sourceSpaceId,
  open,
  onOpenChange,
  onMoved
}: {
  pageId: number
  pageTitle: string
  /** 页面当前父页（同空间打开时作为默认选择）。 */
  parentId: number | null
  sourceSpaceId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onMoved: (targetSpaceId: number) => void
}) {
  const spaces = useSpacesStore((state) => state.spaces)
  const { t } = useTranslation()
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const movePageTo = usePagesStore((state) => state.movePageTo)
  const targets = useMemo(
    () => editableSpaces(spaces, isSiteAdmin),
    [spaces, isSiteAdmin]
  )
  // Radix Select 的 value 只收字符串：数字 id 只在控件边界转换
  const [targetId, setTargetId] = useState("")
  /** 目标空间的页面树（已剪掉被移动页与它的后代），只给父页面选项用。 */
  const [parentNodes, setParentNodes] = useState<PageNode[]>([])
  const [parentsLoading, setParentsLoading] = useState(false)
  const [parentValue, setParentValue] = useState(TOP_LEVEL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setTargetId(
      sourceSpaceId
        ? String(sourceSpaceId)
        : targets[0]
          ? String(targets[0].id)
          : ""
    )
    setError("")
  }, [open, sourceSpaceId, targets])

  // 目标空间的树按需拉取：不动 store 里的当前树，免得侧栏跟着闪
  useEffect(() => {
    if (!open) return
    const target = Number(targetId)
    if (!targetId || !Number.isSafeInteger(target) || target <= 0) {
      setParentNodes([])
      return
    }
    let alive = true
    setParentsLoading(true)
    pagesApi
      .tree(target)
      .then((nodes) => {
        if (alive) setParentNodes(withoutSubtree(nodes, pageId))
      })
      .catch((loadError: unknown) => {
        if (!alive) return
        setParentNodes([])
        setError(describeApiError(loadError))
      })
      .finally(() => {
        if (alive) setParentsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, targetId, pageId])

  // 默认父页面：留在当前空间时是页面现父页，换到别的空间时是顶层
  useEffect(() => {
    if (!open) return
    const sameSpace = Number(targetId) === sourceSpaceId
    const current =
      sameSpace && parentId !== null && findNode(parentNodes, parentId)
        ? String(parentId)
        : TOP_LEVEL
    setParentValue(current)
  }, [open, targetId, parentNodes, sourceSpaceId, parentId])

  const options = useMemo(() => flattenAll(parentNodes), [parentNodes])
  const nextParent = parentValue === TOP_LEVEL ? null : Number(parentValue)
  const target = Number(targetId)
  const unchanged = target === sourceSpaceId && nextParent === parentId

  const submit = async () => {
    if (!targetId || !Number.isSafeInteger(target) || target <= 0) {
      setError(t("page.move.targetRequired"))
      return
    }
    // 落位口径与建页一致：新父页子列表的末尾（已剪掉自身子树）
    const siblings =
      nextParent === null
        ? parentNodes
        : (findNode(parentNodes, nextParent)?.children ?? [])
    setBusy(true)
    setError("")
    try {
      await movePageTo(pageId, target, nextParent, siblings.length)
      onOpenChange(false)
      onMoved(target)
    } catch (moveError) {
      setError(describeApiError(moveError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("page.move.title", { title: pageTitle })}
          </DialogTitle>
          <DialogDescription>{t("page.move.description")}</DialogDescription>
        </DialogHeader>
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("page.move.noTargets")}
          </p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="move-page-target">
                {t("page.move.targetSpace")}
              </Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger id="move-page-target" className="w-full">
                  <SelectValue placeholder={t("page.move.targetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((space) => (
                    <SelectItem key={space.id} value={String(space.id)}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="move-page-parent">
                {t("page.move.parentPage")}
              </Label>
              <Select
                value={parentValue}
                onValueChange={setParentValue}
                disabled={parentsLoading}
              >
                <SelectTrigger id="move-page-parent" className="w-full">
                  <SelectValue placeholder={t("page.move.parentPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TOP_LEVEL}>
                    {t("page.move.topLevel")}
                  </SelectItem>
                  {options.map((row) => (
                    <SelectItem key={row.id} value={String(row.id)}>
                      <span
                        className="block truncate"
                        style={{ paddingLeft: row.depth * INDENT_WIDTH }}
                      >
                        {row.title || t("shell.tree.unnamed")}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={busy || parentsLoading || !targetId || unchanged}
              >
                {busy ? t("page.move.moving") : t("page.move.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
