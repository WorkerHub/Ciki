import { Badge } from "@cloudflare/kumo/components/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"

/**
 * 骨架占位页：只证明工具链跑得通（Vite + Tailwind + shadcn/ui Nova + Kumo），
 * 页面结构、主题与视觉由前端单整体替换。
 */
export function App() {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="flex items-center gap-2 font-heading text-2xl">
        ciki
        <Badge variant="secondary">骨架</Badge>
      </h1>
      <Card>
        <CardHeader>
          <CardTitle>脚手架就位</CardTitle>
          <CardDescription>
            Confluence 粘贴保真的团队 wiki —— 功能随各实现单落地。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button>占位按钮</Button>
          <p className="text-muted-foreground text-xs">
            构建版本：{__APP_VERSION__}（{__APP_BUILD_TIME__}）
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
