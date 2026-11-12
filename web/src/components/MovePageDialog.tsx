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
import { describeApiError } from "@/lib/api"
import { editableSpaces } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 跨空间移动页面：move API 的可选 spaceId 就是目标空间。
 * 缺省不给 parentId，服务端会把页面（连同整棵后代子树）重挂到目标空间的顶层。
 */
export function MovePageDialog({
  pageId,
  pageTitle,
  sourceSpaceId,
  open,
  onOpenChange,
  onMoved
}: {
  pageId: number
  pageTitle: string
  sourceSpaceId: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onMoved: (targetSpaceId: number) => void
}) {
  const spaces = useSpacesStore((state) => state.spaces)
  const { t } = useTranslation()
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  const movePageToSpace = usePagesStore((state) => state.movePageToSpace)
  const targets = useMemo(
    () => editableSpaces(spaces, isSiteAdmin, sourceSpaceId),
    [spaces, isSiteAdmin, sourceSpaceId]
  )
  // Radix Select 的 value 只收字符串：数字 id 只在控件边界转换
  const [targetId, setTargetId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setTargetId(targets[0] ? String(targets[0].id) : "")
    setError("")
  }, [open, targets])

  const submit = async () => {
    const target = Number(targetId)
    if (!targetId || !Number.isSafeInteger(target) || target <= 0) {
      setError(t("page.move.targetRequired"))
      return
    }
    setBusy(true)
    setError("")
    try {
      await movePageToSpace(pageId, target)
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
              <Button type="submit" disabled={busy || !targetId}>
                {busy ? t("page.move.moving") : t("page.move.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
