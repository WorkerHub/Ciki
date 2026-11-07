import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"

const SUPPORTED = [
  ["标题 H1–H6、引用、分割线", "完整保留"],
  ["代码块", "含阅读页行号列形态；浅色高亮 + 语言角标 + 复制按钮"],
  [
    "表格",
    "保留表头、合并单元格（colspan/rowspan）与源列宽比例，超宽可横向滚动"
  ],
  ["列表", "嵌套层级保留；Confluence 任务列表保留勾选状态"],
  ["链接、行内代码、粗体/斜体/下划线/删除线", "完整保留"],
  ["图片（剪贴板里带着图片文件）", "自动上传到图床并插入"],
  [
    "Confluence 附件图片（只有链接）",
    "保留原链接并标黄「未转存」，在编辑页手动上传替换"
  ]
]

/** 应用内帮助：粘贴支持矩阵 + 已知限制（规格 §5 要求写在帮助文案里）。 */
export function HelpButton({ label }: { label?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {label ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="帮助"
            title="帮助"
          >
            <CircleHelp aria-hidden="true" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>粘贴与编辑说明</DialogTitle>
          <DialogDescription>
            直接把 Confluence
            页面里的内容选中复制，粘到编辑器里即可。结构会尽量保真，
            少数源侧限制无法恢复。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">支持的结构</h3>
            <ul className="space-y-1.5">
              {SUPPORTED.map(([item, detail]) => (
                <li
                  key={item}
                  className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6"
                >
                  <span>{item}</span>
                  <span className="text-muted-foreground sm:text-right">
                    {detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
            <h3 className="font-medium">已知限制</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                某些 Confluence
                插件表格的表头在页面上无法选中、根本不会进剪贴板，
                粘贴后表头会是空的 —— 这是源侧限制，wiki
                这边无法恢复，需要手动补。
              </li>
              <li>文字颜色与表格背景色不保留（列宽比例保留）。</li>
              <li>
                Info / Note / Warning / Success 面板会降级成带标签的引用块。
              </li>
            </ul>
          </section>

          <section className="space-y-1 text-muted-foreground">
            <p>
              快捷键：Ctrl/⌘ + S
              保存页面；工具条里可以插表格、链接，也可以单独上传图片。
            </p>
            <p>
              每次保存都会生成一条版本记录，可以在阅读页的「历史」里查看与回滚。
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
