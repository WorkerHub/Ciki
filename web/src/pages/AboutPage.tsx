import { ExternalLink, GitBranch, Info } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { formatIsoUtc } from "@/lib/format"

const REPO_URL = "https://github.com/WorkerHub/Ciki"

const STACK = [
  [
    "前端",
    "React 19 + Vite + TypeScript，Tailwind CSS v4，shadcn/ui（Nova 风格）+ Radix UI + Kumo"
  ],
  [
    "编辑器",
    "TipTap 3（StarterKit / CodeBlockLowlight / Table / TaskList / Image / Link / Underline）"
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
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">这是什么</CardTitle>
          <CardDescription>
            {
              "ciki 是团队内部使用的 wiki。页面按树组织，编辑器支持标题、代码块、表格、任务列表与图片；每次保存都会留下版本记录，可随时回滚，正文支持全文检索。成员按空间协作，登录支持 Passkey 与两步验证，也可用浏览器插件把外部页面剪藏进来。"
            }
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
            <dd>{formatIsoUtc(__APP_BUILD_TIME__)}</dd>
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
    </div>
  )
}
