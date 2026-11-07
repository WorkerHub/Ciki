import { ArrowLeft, Save } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
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
import { usePagesStore } from "@/stores/pages"

/** 编辑页：标题 + 正文，Ctrl/⌘+S 保存，未保存离开要确认（规格 §2）。 */
export function PageEdit() {
  const { pageId } = useParams<{ pageId: string }>()
  const navigate = useNavigate()
  const loadTree = usePagesStore((state) => state.load)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notFound, setNotFound] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const editor = useWikiEditor({
    contentJson: page?.contentJson ?? "",
    onUpdate: () => setDirty(true),
    onError: setError
  })

  useEffect(() => {
    if (!pageId) return
    let alive = true
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
      .catch((loadError: unknown) => {
        if (!alive) return
        if (loadError instanceof ApiError && loadError.status === 404)
          setNotFound(true)
        else setError(describeApiError(loadError))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [pageId])

  const save = useCallback(async () => {
    if (!editor || !pageId || saving) return
    setSaving(true)
    setError("")
    try {
      const payload = editorPayload(editor)
      const updated = await pagesApi.update(pageId, {
        title: title.trim() || "未命名页面",
        ...payload
      })
      setDirty(false)
      setSavedAt(updated.updatedAt)
      await loadTree()
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }, [editor, pageId, saving, title, loadTree])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [save])

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

  if (loading) {
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

  return (
    <div className="max-w-[900px] space-y-3">
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
              disabled={saving || !editor}
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

      <WikiEditorSurface editor={editor} error={error} onError={setError} />

      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>还有未保存的修改</AlertDialogTitle>
            <AlertDialogDescription>
              离开后这些修改会丢失。要先保存再走吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              留在此页
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await save()
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
