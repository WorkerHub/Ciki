import { useContext, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { UNSAFE_DataRouterContext, useBlocker } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

function DataRouterUnsavedChangesGuard({ isDirty }: { isDirty: boolean }) {
  const { t } = useTranslation()

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname
  )

  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") {
          blocker.reset?.()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common.unsavedChanges.title")}</DialogTitle>
          <DialogDescription>
            {t("common.unsavedChanges.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => blocker.reset?.()}
          >
            {t("common.unsavedChanges.stay")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => blocker.proceed?.()}
          >
            {t("common.unsavedChanges.discard")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 未保存修改阻断守卫：
 * 1. SPA 内部路由切换（Tab 切换、菜单跳转、前进后退）时通过 useBlocker 拦截；
 * 2. 弹出确认对话框提示用户（留在本页 vs 放弃修改）；
 * 3. 浏览器硬刷新 / 关窗时通过 beforeunload 触发原生提示；
 * 4. 在非 DataRouter 环境（如单元测试单体渲染）自动降级，避免 useBlocker 抛错。
 */
export function UnsavedChangesGuard({ isDirty }: { isDirty: boolean }) {
  const hasDataRouter = Boolean(useContext(UNSAFE_DataRouterContext))

  useEffect(() => {
    if (!isDirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty])

  if (!hasDataRouter) {
    return null
  }

  return <DataRouterUnsavedChangesGuard isDirty={isDirty} />
}
