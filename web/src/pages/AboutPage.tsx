import { ExternalLink, GitBranch, Info } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { formatDateTime } from "@/lib/format"

const REPO_URL = "https://github.com/WorkerHub/Ciki"

const STACK = [
  [
    "前端",
    "React 19 + Vite + TypeScript，Tailwind CSS v4，shadcn/ui（Nova 风格）+ Radix UI + Kumo"
  ],
  [
    "编辑器",
    "TipTap 2（StarterKit / CodeBlockLowlight / Table / TaskList / Image / Link / Underline）"
  ],
  ["后端", "Cloudflare Workers + Hono，D1（SQLite）+ FTS5 全文检索"],
  ["图片", "Cloudflare R2，经 /api/files 会话校验后回源"],
  [
    "交互基础",
    "react-resizable-panels（分栏）、dnd-kit（页面树拖拽）、Zustand（状态）、Lucide（图标）、Motion（动效）"
  ]
] as const

export function AboutPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <Info className="size-4 text-muted-foreground" aria-hidden="true" />
          关于 ciki
        </h1>
        <p className="text-xs text-muted-foreground">
          把 Confluence 页面原样粘进来的团队 wiki。
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">这是什么</CardTitle>
          <CardDescription>
            ciki 是给团队内部用的 wiki：从 Confluence
            里选中内容复制，粘进编辑器就能保住标题层级、
            代码块、表格合并与列宽、嵌套列表与任务勾选、链接与行内样式。页面按树组织，每次保存都会留下
            可回滚的版本记录，正文进全文检索。
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">技术栈</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2">
            {STACK.map(([label, detail]) => (
              <div
                key={label}
                className="grid gap-0.5 sm:grid-cols-[6rem_1fr] sm:gap-3"
              >
                <dt className="text-xs font-medium text-muted-foreground">
                  {label}
                </dt>
                <dd className="text-sm">{detail}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            构建信息
          </CardTitle>
          <CardDescription>
            版本号与构建时间由 CI 在构建时注入，源码里不写死。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr] sm:gap-3">
            <dt className="text-xs font-medium text-muted-foreground">
              版本号
            </dt>
            <dd className="font-mono text-sm break-all">{__APP_VERSION__}</dd>
            <dt className="text-xs font-medium text-muted-foreground">
              构建时间
            </dt>
            <dd>{formatDateTime(__APP_BUILD_TIME__)}（北京时间）</dd>
          </dl>
          <Separator />
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"
          >
            开源地址：{REPO_URL}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">粘贴保真的边界</CardTitle>
          <CardDescription>
            文字颜色与表格背景色不保留（列宽比例保留）；Info / Warning
            等面板降级为带标签的引用块； Confluence
            附件图片不会自动转存，需要手动上传替换；某些 Confluence
            插件表格的表头本身 无法被选中，因此不会进入剪贴板。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            顶栏的「帮助」里有完整支持矩阵与操作快捷键。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
