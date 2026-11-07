import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper
} from "@tiptap/react"
import { Check, Code2, Copy } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { COMMON_LANGUAGES, languageLabel } from "@/editor/languages"

const NO_LANGUAGE = "none"

/**
 * 代码块 NodeView：语言角标 + 复制按钮在「编辑态与阅读态都显示」（规格 §4）。
 * 高亮由 CodeBlockLowlight 的 decoration 完成，正文里始终是纯文本，
 * 所以复制出来的永远是代码本身，不会带上 span。
 */
export function CodeBlockView({
  node,
  editor,
  updateAttributes
}: NodeViewProps) {
  const language = (node.attrs.language as string | null) || ""
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <NodeViewWrapper className="code-block" data-code-block="">
      <div
        className="flex items-center justify-between gap-2 border-b border-[color-mix(in_oklch,var(--border)_65%,transparent)] bg-[#eef1f4] px-2.5 py-1"
        contentEditable={false}
        data-code-header=""
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[#57606a]">
          <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate" data-code-language="">
            {languageLabel(language)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editor.isEditable ? (
            <Select
              value={language || NO_LANGUAGE}
              onValueChange={(value) =>
                updateAttributes({
                  language: value === NO_LANGUAGE ? null : value
                })
              }
            >
              <SelectTrigger
                size="sm"
                aria-label="代码语言"
                className="h-6 w-[7.5rem] border-transparent bg-transparent px-1.5 text-[11px] text-[#57606a] hover:bg-black/5"
              >
                <SelectValue placeholder="选择语言" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={NO_LANGUAGE}>纯文本</SelectItem>
                {COMMON_LANGUAGES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={copy}
            aria-label={copied ? "已复制" : "复制代码"}
            title={copied ? "已复制" : "复制代码"}
            className="text-[#57606a] hover:bg-black/5"
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      <pre>
        <NodeViewContent
          as="code"
          className={language ? `language-${language}` : undefined}
        />
      </pre>
    </NodeViewWrapper>
  )
}
