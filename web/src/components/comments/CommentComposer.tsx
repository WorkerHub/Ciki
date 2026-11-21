import { Eye, EyeOff } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CommentBody } from "@/components/comments/CommentBody"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { describeApiError } from "@/lib/api"

interface CommentComposerProps {
  value: string
  onChange: (value: string) => void
  /** 服务端同一条渲染链的预览：返回净化后的 HTML。 */
  onPreview: (bodyMd: string) => Promise<string>
  onSubmit: () => void
  onCancel?: () => void
  submitLabel: string
  /** 文本域的无障碍名，同时把三处输入框区分开（发表/回复/编辑）。 */
  label: string
  pending: boolean
  autoFocus?: boolean
}

/**
 * 发表/回复/编辑共用的输入框：多行文本域 + 「预览」切换。
 *
 * 预览调服务端渲染端点（与列表同一条 Markdown → 净化链），前端不引 MD 库，
 * 所以预览里看到的与发表后看到的必然一致。预览态下文本域收起，收起预览就
 * 回到同一份草稿；空正文只靠「主按钮禁用」表达，不加提示文案。
 */
export function CommentComposer({
  value,
  onChange,
  onPreview,
  onSubmit,
  onCancel,
  submitLabel,
  label,
  pending,
  autoFocus
}: CommentComposerProps) {
  const { t } = useTranslation()
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // 快速开合时丢弃过期响应：关掉预览后被回来的 HTML 不能把它又弹开
  const requestSeq = useRef(0)

  const empty = !value.trim()
  const open = previewHtml !== null

  async function togglePreview() {
    if (open) {
      requestSeq.current += 1
      setPreviewHtml(null)
      return
    }
    const mine = ++requestSeq.current
    setPreviewing(true)
    try {
      const html = await onPreview(value)
      if (mine === requestSeq.current) setPreviewHtml(html)
    } catch (previewError: unknown) {
      if (mine === requestSeq.current)
        toast.error(describeApiError(previewError))
    } finally {
      if (mine === requestSeq.current) setPreviewing(false)
    }
  }

  return (
    <div data-comment-composer="" className="space-y-1.5">
      {open ? (
        <div className="rounded-lg border border-input px-2.5 py-2">
          <CommentBody html={previewHtml} />
        </div>
      ) : (
        <Textarea
          aria-label={label}
          value={value}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <Toggle
          size="sm"
          pressed={open}
          aria-label={t("comments.preview")}
          disabled={empty || pending || previewing}
          onPressedChange={() => void togglePreview()}
        >
          {open ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {t("comments.preview")}
        </Toggle>
        <div className="flex items-center gap-1">
          {onCancel ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={onCancel}
            >
              {t("common.cancel")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={empty || pending}
            onClick={onSubmit}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
