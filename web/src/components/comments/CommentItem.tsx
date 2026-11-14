import { Pencil, Reply, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { CommentBody } from "@/components/comments/CommentBody"
import { CommentComposer } from "@/components/comments/CommentComposer"
import { UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import type { CommentDto } from "@/lib/api"
import { formatDateTime, formatRelative } from "@/lib/format"

interface CommentItemProps {
  comment: CommentDto
  /** 是否正就地编辑这一条；草稿由评论区统一持有（同一时刻只有一条在编辑）。 */
  editing: boolean
  editDraft: string
  pending: boolean
  onEditDraftChange: (value: string) => void
  onPreview: (bodyMd: string) => Promise<string>
  onReply: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onDelete: () => void
}

/**
 * 一条评论（顶层与回复共用）：头像、名字、时间、渲染后的正文、操作行。
 * 「编辑」「删除」完全照服务端的 canEdit / canDelete 显隐——管理员删他人评论
 * 也走同一条路，前端不按 authorId 自己推权限。
 * 已软删的那条只留占位文字，不给任何操作（它的作用只是撑住所在串的结构）。
 */
export function CommentItem({
  comment,
  editing,
  editDraft,
  pending,
  onEditDraftChange,
  onPreview,
  onReply,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete
}: CommentItemProps) {
  const { t } = useTranslation()
  const deleted = Boolean(comment.deletedAt)
  return (
    <div data-comment-id={comment.id} className="flex gap-3">
      <UserAvatar
        user={{
          username: comment.authorName,
          email: "",
          avatarUrl: comment.authorAvatarUrl
        }}
        className="mt-0.5 size-8"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium break-words">
            {comment.authorName}
          </span>
          <time
            dateTime={comment.createdAt}
            title={formatDateTime(comment.createdAt)}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {formatRelative(comment.createdAt)}
          </time>
          {comment.editedAt ? (
            <span className="text-xs text-muted-foreground">
              {t("comments.edited")}
            </span>
          ) : null}
        </div>
        {editing ? (
          <CommentComposer
            value={editDraft}
            onChange={onEditDraftChange}
            onPreview={onPreview}
            onSubmit={onSave}
            onCancel={onCancelEdit}
            submitLabel={t("common.save")}
            label={t("comments.editLabel")}
            pending={pending}
            autoFocus
          />
        ) : deleted ? (
          <p className="py-0.5 text-sm text-muted-foreground">
            {t("comments.deleted")}
          </p>
        ) : (
          <>
            <CommentBody html={comment.html} />
            <div className="flex flex-wrap items-center gap-1">
              <Button type="button" size="xs" variant="ghost" onClick={onReply}>
                <Reply aria-hidden="true" />
                {t("comments.reply")}
              </Button>
              {comment.canEdit ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={onEdit}
                >
                  <Pencil aria-hidden="true" />
                  {t("comments.edit")}
                </Button>
              ) : null}
              {comment.canDelete ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={onDelete}
                >
                  <Trash2 aria-hidden="true" />
                  {t("comments.delete")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
