import { ArrowLeft, Save, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useBlocker, useNavigate, useParams } from "react-router"
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
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  editorPayload,
  parseContentJson,
  useWikiEditor,
  WikiEditorSurface
} from "@/editor/Editor"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import {
  ApiError,
  describeApiError,
  type PageContentDetail,
  pagesApi
} from "@/lib/api"
import { formatTime } from "@/lib/format"
import { pagePath, parseIdParam } from "@/lib/routes"
import { readScrollAnchor, restoreScrollAnchor } from "@/lib/scroll-anchor"
import { canEdit } from "@/lib/space"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 编辑页：标题 + 正文，Ctrl/⌘+S 保存，未保存离开要确认（规格 §2）。 */
export function PageEdit() {
  const { t } = useTranslation()
  const params = useParams<{ pageId: string }>()
  const pageId = parseIdParam(params.pageId)
  const navigate = useNavigate()
  const loadTree = usePagesStore((state) => state.load)
  const spaces = useSpacesStore((state) => state.spaces)
  const spacesStatus = useSpacesStore((state) => state.status)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const selectSpace = useSpacesStore((state) => state.select)
  const [page, setPage] = useState<PageContentDetail | null>(null)
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const role = useSpaceRole(page?.spaceId)
  const readOnly = page !== null && !canEdit(role)
  const syncedPage = useRef<number | null>(null)
  /** 「放弃修改」已经放行过这一次导航：blocker 不能再拦（它读到的是置位前的 dirty）。 */
  const leavingByCancel = useRef(false)

  const editor = useWikiEditor({
    contentJson: page?.contentJson ?? "",
    onUpdate: () => setDirty(true),
    onError: setSaveError
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken 只是「重新加载」的触发器
  useEffect(() => {
    if (pageId === null) {
      // 非数字 id：不发请求，直接落到「页面不存在」
      setPage(null)
      setLoading(false)
      setNotFound(true)
      return
    }
    let alive = true
    // 换页先把旧页状态清干净：避免把 A 的正文/标题写进 B
    setPage(null)
    setTitle("")
    setDirty(false)
    setSavedAt(null)
    setLoadError("")
    setNotFound(false)
    setLoading(true)
    pagesApi
      .getForEditor(pageId)
      .then((detail) => {
        if (!alive) return
        setPage(detail)
        setTitle(detail.title)
        setSavedAt(detail.updatedAt)
        setDirty(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        if (error instanceof ApiError && error.status === 404) setNotFound(true)
        else setLoadError(describeApiError(error))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [pageId, reloadToken])

  /** 页面数据不到位就绝不允许写回：加载中、加载失败、换页途中都返回 false。 */
  const ready = Boolean(
    editor && page && pageId !== null && page.id === pageId && !loading
  )

  // 直链进来时空间跟着页面走（与阅读页同一口径），每个页面只同步一次
  useEffect(() => {
    if (!page || spacesStatus !== "ready") return
    if (!spaces.some((space) => space.id === page.spaceId)) return
    if (syncedPage.current === page.id) return
    syncedPage.current = page.id
    if (page.spaceId !== currentSpaceId) selectSpace(page.spaceId)
  }, [page, spaces, spacesStatus, currentSpaceId, selectSpace])

  // 从阅读页进来时按记下的锚点落回原处（每次载入只做一次）。
  // 正文到位前 useEditor 会重建一次实例：DOM 没挂进文档、或顶层块数还与 contentJson
  // 对不上时先不动手，等下一次渲染拿到的就是最终实例，否则会按空文档算错位置。
  const anchorRestored = useRef<number | null>(null)
  useEffect(() => {
    if (!ready || !editor || !page) return
    if (anchorRestored.current === page.id) return
    if (editor.isDestroyed || !editor.view.dom.isConnected) return
    const expected = parseContentJson(page.contentJson)?.content?.length ?? 0
    if (editor.state.doc.childCount !== expected) return
    anchorRestored.current = page.id
    const anchor = readScrollAnchor(page.id)
    if (!anchor) return
    // 吸顶工具条会盖住判定线以上的部分：落点要压到条下面（手机上工具条三行更高，
    // 所以量实测高度，不写常量）
    const stickyBar = document.querySelector<HTMLElement>(
      "[data-editor-sticky-bar]"
    )
    restoreScrollAnchor(editor.view.dom, anchor, stickyBar?.offsetHeight ?? 0)
  }, [ready, editor, page])

  const save = useCallback(async (): Promise<boolean> => {
    if (
      !editor ||
      !page ||
      pageId === null ||
      page.id !== pageId ||
      loading ||
      saving
    ) {
      return false
    }
    setSaving(true)
    setSaveError("")
    try {
      const payload = editorPayload(editor)
      const updated = await pagesApi.update(pageId, {
        title: title.trim() || t("page.untitled"),
        ...payload
      })
      setDirty(false)
      setSavedAt(updated.updatedAt)
      await loadTree()
      return true
    } catch (error) {
      setSaveError(describeApiError(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [editor, page, pageId, loading, saving, title, loadTree, t])

  /** 取消编辑：没改动就直接回阅读态；有未保存改动先问一句，不自己丢内容。 */
  const cancelEdit = useCallback(() => {
    if (pageId === null) return
    if (dirty) {
      setCancelOpen(true)
      return
    }
    navigate(pagePath(pageId))
  }, [dirty, navigate, pageId])

  /** 确认放弃：不发保存请求、不生成版本，直接回阅读态（位置由阅读页的锚点恢复）。 */
  const discardChanges = useCallback(() => {
    if (pageId === null) return
    setCancelOpen(false)
    leavingByCancel.current = true
    navigate(pagePath(pageId))
  }, [navigate, pageId])

  // 页面加载完成前不挂 Ctrl/⌘+S：否则会把空文档写回页面
  useEffect(() => {
    if (!ready) return
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [ready, save])

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leavingByCancel.current &&
      dirty &&
      currentLocation.pathname !== nextLocation.pathname
  )

  // 空间列表还在路上时角色未知，先别判只读：否则直链/刷新会闪一下「只读成员」
  if (loading || spacesStatus === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label={t("page.loading")}>
        <div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {t("page.edit.notFound")}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => navigate("/")}
        >
          {t("page.backHome")}
        </Button>
      </div>
    )
  }

  // 加载失败：给重试入口，绝不渲染一个空编辑器
  if (!page || pageId === null || page.id !== pageId) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError || t("page.loadFailed")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("page.edit.loadGuard")}
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Button
            size="sm"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t("page.edit.reload")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/")}>
            {t("page.backHome")}
          </Button>
        </div>
      </div>
    )
  }

  // 只读空间：不挂编辑器，只给一句说明和返回阅读的入口
  if (readOnly && page) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {t("page.edit.readOnly")}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => navigate(pagePath(page.id))}
        >
          {t("page.edit.backToRead")}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <header className="space-y-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => navigate(pagePath(pageId))}
          className="text-muted-foreground"
        >
          <ArrowLeft aria-hidden="true" />
          {t("page.edit.backToRead")}
        </Button>
        <Input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            setDirty(true)
          }}
          aria-label={t("page.edit.titleLabel")}
          name="page-title"
          maxLength={255}
          placeholder={t("page.edit.titlePlaceholder")}
          className="h-auto border-0 bg-transparent px-0 font-heading text-[1.75rem] font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-[1.75rem] dark:bg-transparent"
        />
        <Separator />
        <p className="text-[11px] text-muted-foreground">
          {t("page.edit.styleHint")}
        </p>
      </header>

      {/* 全页唯一的保存入口：状态与按钮都在吸顶工具条的行尾，长文滚到哪儿都能存。 */}
      <WikiEditorSurface
        editor={editor}
        error={saveError}
        onError={setSaveError}
        actions={
          <>
            <span
              className="whitespace-nowrap text-xs text-muted-foreground"
              aria-live="polite"
            >
              {saving
                ? t("page.edit.saving")
                : dirty
                  ? t("page.edit.unsaved")
                  : savedAt
                    ? t("page.edit.savedAt", { time: formatTime(savedAt) })
                    : ""}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={cancelEdit}
              disabled={saving}
            >
              <X aria-hidden="true" />
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={saving || !ready}
            >
              <Save aria-hidden="true" />
              {t("common.save")}
            </Button>
          </>
        }
      />

      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.edit.leaveDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("page.edit.leaveDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {saveError ? (
            <p role="alert" className="text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              {t("page.edit.leaveDialog.stay")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async (event) => {
                // 保存失败就留在对话框里：不能让「保存并离开」把未保存内容带走
                const saved = await save()
                if (!saved) {
                  event.preventDefault()
                  return
                }
                blocker.proceed?.()
              }}
            >
              {t("page.edit.leaveDialog.saveAndLeave")}
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => blocker.proceed?.()}
            >
              {t("page.edit.leaveDialog.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 取消编辑的二次确认：只问这一句，不写说明文字（UI 极简口径）。 */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("page.edit.cancelDialog.title")}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("page.edit.cancelDialog.keepEditing")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={discardChanges}>
              {t("page.edit.cancelDialog.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
