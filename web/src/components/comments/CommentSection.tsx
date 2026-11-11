import { useState } from "react"
import { CommentComposer } from "@/components/comments/CommentComposer"
import { CommentItem } from "@/components/comments/CommentItem"
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
import { Separator } from "@/components/ui/separator"
import { useComments } from "@/hooks/useComments"
import { type CommentDto, type CommentThread, commentsApi } from "@/lib/api"

/**
 * 阅读页页尾评论区（规格 v1.0 §4）。
 *
 * 位置与结构：正文之后的「评论」+ 条数（0 时不显数字）、串列表（顶层 + 一级回复
 * 平铺）、区底固定的顶层发表框。数据全部来自 /api/pages/:pageId/comments 一次
 * 整页返回；发表/编辑/删除后就地重拉这个列表，不整页刷新。
 *
 * 回复只一级：对回复点「回复」展开的仍是该串末尾的同一个行内框，提交的 parentId
 * 恒为顶层评论 id（契约的归一规则）。
 */
export function CommentSection({ pageId }: { pageId: string }) {
  const { data, status, error, pending, reload, create, update, remove } =
    useComments(pageId)
  const [topDraft, setTopDraft] = useState("")
  const [replyDraft, setReplyDraft] = useState("")
  const [editDraft, setEditDraft] = useState("")
  // 正在回复的顶层评论 id；同一时刻只开一个回复框
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CommentDto | null>(null)

  const preview = (bodyMd: string) =>
    commentsApi.preview(pageId, bodyMd).then((result) => result.html)

  const total = data?.total ?? 0
  const hasData = data !== null

  function openReplyBox(threadId: string) {
    // 已经是这条串的回复框就保持原样：别把正在敲的草稿清掉
    if (replyTo === threadId) return
    setReplyTo(threadId)
    setReplyDraft("")
  }

  function closeReplyBox() {
    setReplyTo(null)
    setReplyDraft("")
  }

  function startEdit(comment: CommentDto) {
    setEditingId(comment.id)
    setEditDraft(comment.bodyMd)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft("")
  }

  async function submitTop() {
    if (await create(topDraft, null)) setTopDraft("")
  }

  async function submitReply(threadId: string) {
    if (!(await create(replyDraft, threadId))) return
    closeReplyBox()
  }

  async function saveEdit(commentId: string) {
    if (!(await update(commentId, editDraft))) return
    cancelEdit()
  }

  /**
   * 删除确认：成功才关框，失败留在原处可重试（错误由 useComments 用 toast 给出）。
   * Radix 的 AlertDialogAction 本质是 Close 按钮，点了就关；这里在 onClick 里
   * preventDefault 把关闭时机接管过来（成功才 setDeleteTarget(null)）。
   */
  async function confirmDelete() {
    if (!deleteTarget) return
    if (await remove(deleteTarget.id)) setDeleteTarget(null)
  }

  function renderItem(comment: CommentDto, onReply: () => void) {
    return (
      <CommentItem
        key={comment.id}
        comment={comment}
        editing={editingId === comment.id}
        editDraft={editDraft}
        pending={pending}
        onEditDraftChange={setEditDraft}
        onPreview={preview}
        onReply={onReply}
        onEdit={() => startEdit(comment)}
        onCancelEdit={cancelEdit}
        onSave={() => void saveEdit(comment.id)}
        onDelete={() => setDeleteTarget(comment)}
      />
    )
  }

  function renderThread(thread: CommentThread) {
    const replyOpen = replyTo === thread.id
    return (
      <div key={thread.id} className="space-y-3">
        {renderItem(thread, () => openReplyBox(thread.id))}
        {thread.replies.length > 0 || replyOpen ? (
          <div className="space-y-4 border-l border-border pl-4">
            {thread.replies.map((reply) =>
              renderItem(reply, () => openReplyBox(thread.id))
            )}
            {replyOpen ? (
              <CommentComposer
                value={replyDraft}
                onChange={setReplyDraft}
                onPreview={preview}
                onSubmit={() => void submitReply(thread.id)}
                onCancel={closeReplyBox}
                submitLabel="回复"
                label="回复内容"
                pending={pending}
                autoFocus
              />
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section aria-labelledby="comments-heading" className="space-y-3">
      <Separator />
      <h2
        id="comments-heading"
        className="flex items-baseline gap-2 font-heading text-base font-semibold tracking-tight"
      >
        评论
        {total > 0 ? (
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            {total}
          </span>
        ) : null}
      </h2>

      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void reload()}
          >
            重试
          </Button>
        </div>
      ) : null}

      {status === "loading" && !hasData ? (
        <div role="status" aria-label="评论加载中" className="space-y-3">
          <div className="h-14 animate-pulse rounded-lg bg-muted/60" />
          <div className="h-14 animate-pulse rounded-lg bg-muted/60" />
        </div>
      ) : null}

      {hasData && data.threads.length > 0 ? (
        <div className="space-y-5">{data.threads.map(renderThread)}</div>
      ) : null}

      {hasData ? (
        <CommentComposer
          value={topDraft}
          onChange={setTopDraft}
          onPreview={preview}
          onSubmit={() => void submitTop()}
          submitLabel="发表"
          label="发表评论"
          pending={pending}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条评论？</AlertDialogTitle>
            <AlertDialogDescription>删除后无法恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                // 拦住 Radix Close 的自动关闭：请求在途/失败时对话框留着
                event.preventDefault()
                void confirmDelete()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
