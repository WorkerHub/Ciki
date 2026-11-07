import { Empty } from "@cloudflare/kumo/components/empty"
import { FileQuestion } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"

export function NotFound() {
  return (
    <Empty
      icon={<FileQuestion />}
      title="页面不存在"
      description="链接可能已经失效，或者页面被移进了回收站。"
      contents={
        <Button asChild size="sm" variant="outline">
          <Link to="/">回到首页</Link>
        </Button>
      }
    />
  )
}
