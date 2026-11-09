import { ArrowLeft, Save } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
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
  useWikiEditor,
  WikiEditorSurface
} from "@/editor/Editor"
import {
  ApiError,
  describeApiError,
  type PageDetail,
  pagesApi
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { canEdit } from "@/lib/space"
import { useSpaceRole } from "@/hooks/useSpaceRole"
import { usePagesStore } from "@/stores/pages"
import { useSpacesStore } from "@/stores/spaces"

/** 编辑页：标题 + 正文，Ctrl/⌘+S 保存，未保存离开要确认（规格 §2）。 */
export function PageEdit() {
  const { pageId } = useParams<{ pageId: string }>()
  const navigate = useNavigate()
  const loadTree = usePagesStore((state) => state.load)
  const spaces = useSpacesStore((state) => state.spaces)
  const spacesStatus = useSpacesStore((state) => state.status)
  const currentSpaceId = useSpacesStore((state) => state.currentId)
  const selectSpace = useSpacesStore((state) => state.select)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [notFound, setNotFound] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const role = useSpaceRole(page?.spaceId)
  const readOnly = page !== null && !canEdit(role)
  const syncedPage = useRef<string | null>(null)

  const editor = useWikiEditor({
    contentJson: page?.contentJson ?? "",
    onUpdate: () => setDirty(true),
    onError: setSaveError
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken 只是「重新加载」的触发器
  useEffect(() => {
    if (!pageId) return
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
      .get(pageId)
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
    editor && page && pageId && page.id === pageId && !loading
  )

  // 直链进来时空间跟着页面走（与阅读页同一口径），每个页面只同步一次
  useEffect(() => {
    if (!page || spacesStatus !== "ready") return
    if (!spaces.some((space) => space.id === page.spaceId)) return
    if (syncedPage.current === page.id) return
    syncedPage.current = page.id
    if (page.spaceId !== currentSpaceId) selectSpace(page.spaceId)
  }, [page, spaces, spacesStatus, currentSpaceId, selectSpace])

  const save = useCallback(async (): Promise<boolean> => {
    if (
      !editor ||
      !page ||
      !pageId ||
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
        title: title.trim() || "未命名页面",
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
  }, [editor, page, pageId, loading, saving, title, loadTree])

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
      dirty && currentLocation.pathname !== nextLocation.pathname
  )

  // 空间列表还在路上时角色未知，先别判只读：否则直链/刷新会闪一下「只读成员」
  if (loading || spacesStatus === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label="页面加载中">
        <div className="h-8 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted/60" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">页面不存在或已删除。</p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => navigate("/")}
        >
          回到首页
        </Button>
      </div>
    )
  }

  // 加载失败：给重试入口，绝不渲染一个空编辑器
  if (!page || page.id !== pageId) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
        <p role="alert" className="text-sm text-destructive">
          {loadError || "页面加载失败"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          为了不覆盖已有内容，加载完成前不会打开编辑器。
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <Button
            size="sm"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            重新加载
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate("/")}>
            回到首页
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
          你是这个空间的只读成员，不能编辑页面。
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => navigate(`/p/${page.id}`)}
        >
          返回阅读
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/p/${pageId}`)}
            className="text-muted-foreground"
          >
            <ArrowLeft aria-hidden="true" />
            返回阅读
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {saving
                ? "保存中…"
                : dirty
                  ? "有未保存的更改"
                  : savedAt
                    ? `已保存 ${formatDateTime(savedAt).slice(11)}`
                    : ""}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={saving || !ready}
            >
              <Save aria-hidden="true" />
              保存
            </Button>
          </div>
        </div>
        <Input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            setDirty(true)
          }}
          aria-label="页面标题"
          name="page-title"
          maxLength={255}
          placeholder="页面标题"
          className="h-auto border-0 bg-transparent px-0 font-heading text-[1.75rem] font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-[1.75rem] dark:bg-transparent"
        />
        <Separator />
        <p className="text-[11px] text-muted-foreground">
          编辑态与阅读态使用同一套渲染样式；每次保存都会生成一条可回滚的版本记录。
        </p>
      </header>

      <WikiEditorSurface
        editor={editor}
        error={saveError}
        onError={setSaveError}
      />

      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>还有未保存的修改</AlertDialogTitle>
            <AlertDialogDescription>
              离开后这些修改会丢失。要先保存再走吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          {saveError ? (
            <p role="alert" className="text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              留在此页
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
              保存并离开
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => blocker.proceed?.()}
            >
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
