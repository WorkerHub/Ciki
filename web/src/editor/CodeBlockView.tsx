import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper
} from "@tiptap/react"
import { Check, ChevronDown, ChevronRight, Code2, Copy } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { COMMON_LANGUAGES, languageLabel } from "@/editor/languages"
import { resolveInitialCollapsed } from "@/lib/code-block-collapse"

const NO_LANGUAGE = "none"

/**
 * 折叠栏与「展开代码/收起代码」入口共用一套外观（11px、浅色、悬停变深），
 * 位置都固定在代码块顶那条栏上。两份类名各自完整，不靠覆盖（cn 不合并 tailwind）。
 */
const COLLAPSE_BAR =
  "flex w-full items-center gap-1.5 bg-[#eef1f4] px-2.5 py-1 text-left text-[11px] font-medium text-[#57606a] hover:bg-black/5"
const COLLAPSE_ENTRY =
  "flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-[#57606a] hover:bg-black/5"

/**
 * 代码块 NodeView：语言角标 + 复制按钮在「编辑态与阅读态都显示」（规格 §4）。
 * 高亮由 CodeBlockLowlight 的 decoration 完成，正文里始终是纯文本，
 * 所以复制出来的永远是代码本身，不会带上 span。
 *
 * 折叠只在阅读态生效（规格 §三：编辑态永不折叠，作者要能改全文）：
 * - 初始折叠的块渲染成一条折叠栏，展开后栏内换成「收起代码」入口；
 * - <pre> 始终留在 DOM 里（NodeViewContent 的 contentDOM 不能摘），靠 hidden 属性藏起来。
 */
export function CodeBlockView({
  node,
  editor,
  updateAttributes
}: NodeViewProps) {
  const language = (node.attrs.language as string | null) || ""
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // 只有「初始折叠」的块给展开/收起入口；初始展开的块不加控件（UI 极简）
  const collapsible =
    !editor.isEditable &&
    resolveInitialCollapsed(node.attrs.collapsed, node.textContent)
  const [opened, setOpened] = useState(false)
  const collapsed = collapsible && !opened
  const panelId = useId()
  const toggleLabelId = useId()

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
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpened(true)}
          aria-expanded={false}
          aria-controls={panelId}
          className={COLLAPSE_BAR}
        >
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
          {language ? (
            <span className="truncate">{languageLabel(language)}</span>
          ) : null}
          <span className="truncate">{t("editor.codeBlock.show")}</span>
        </button>
      ) : (
        <div
          className="flex items-center justify-between gap-2 border-b border-[color-mix(in_oklch,var(--border)_65%,transparent)] bg-[#eef1f4] px-2.5 py-1"
          contentEditable={false}
          data-code-header=""
        >
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[#57606a]">
            <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate" data-code-language="">
              {languageLabel(language) ?? t("editor.languages.plaintext")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {collapsible ? (
              <button
                type="button"
                onClick={() => setOpened(false)}
                aria-expanded={true}
                aria-controls={panelId}
                className={COLLAPSE_ENTRY}
              >
                <ChevronDown aria-hidden="true" />
                {t("editor.codeBlock.hide")}
              </button>
            ) : null}
            {editor.isEditable ? (
              <>
                <span id={toggleLabelId} className="text-[11px] text-[#57606a]">
                  {t("editor.codeBlock.collapseByDefault")}
                </span>
                <Switch
                  size="sm"
                  aria-labelledby={toggleLabelId}
                  checked={node.attrs.collapsed === true}
                  onCheckedChange={(checked) =>
                    updateAttributes({ collapsed: checked })
                  }
                />
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
                    aria-label={t("editor.codeBlock.language")}
                    className="h-6 w-[7.5rem] border-transparent bg-transparent px-1.5 text-[11px] text-[#57606a] hover:bg-black/5"
                  >
                    <SelectValue
                      placeholder={t("editor.codeBlock.languagePlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NO_LANGUAGE}>
                      {t("editor.languages.plaintext")}
                    </SelectItem>
                    {COMMON_LANGUAGES.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={copy}
              aria-label={
                copied
                  ? t("editor.codeBlock.copied")
                  : t("editor.codeBlock.copy")
              }
              title={
                copied
                  ? t("editor.codeBlock.copied")
                  : t("editor.codeBlock.copy")
              }
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
      )}
      <pre id={panelId} hidden={collapsed}>
        {/*
          v3 的 NodeViewContent 用 NoInfer<T> 拦掉了对 as 的推断，必须显式给泛型参数。
          保留 <code> 元素：index.css 的 .code-block > pre > code 样式依赖它。
        */}
        <NodeViewContent<"code">
          as="code"
          className={language ? `language-${language}` : undefined}
          /*
            NodeViewContent 默认给内容元素挂行内 `white-space: pre-wrap`，代码会按空格折行。
            它把 props.style 合并在自己的默认值之后，所以这里传 pre 就能就地覆盖——
            不用 !important 去压行内样式（index.css 的 word-break 复位仍保留）。
          */
          style={{ whiteSpace: "pre" }}
        />
      </pre>
    </NodeViewWrapper>
  )
}
