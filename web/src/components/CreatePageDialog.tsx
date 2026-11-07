import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { describeApiError, type PageDetail } from "@/lib/api"
import { usePagesStore } from "@/stores/pages"

/** 新建页面：只问标题（父页在打开时已确定），建完直接进编辑页。 */
export function CreatePageDialog({
  open,
  onOpenChange,
  parentId,
  parentTitle,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
  parentTitle?: string
  onCreated: (page: PageDetail) => void
}) {
  const createPage = usePagesStore((state) => state.createPage)
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle("")
      setError("")
    }
  }, [open])

  const submit = async () => {
    const value = title.trim()
    if (!value) {
      setError("请填写页面标题")
      return
    }
    setBusy(true)
    setError("")
    try {
      const page = await createPage(value, parentId)
      onOpenChange(false)
      onCreated(page)
    } catch (submitError) {
      setError(describeApiError(submitError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建页面</DialogTitle>
          <DialogDescription>
            {parentTitle
              ? `将创建在「${parentTitle}」下面。`
              : "将创建在页面树的顶层。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-page-title">页面标题</Label>
            <Input
              id="new-page-title"
              name="page-title"
              autoFocus
              value={title}
              maxLength={255}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：支付服务部署手册"
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "创建中…" : "创建并编辑"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
