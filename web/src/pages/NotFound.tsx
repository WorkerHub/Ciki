import { Empty } from "@cloudflare/kumo/components/empty"
import { FileQuestion } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"

export function NotFound() {
  const { t } = useTranslation()
  return (
    <Empty
      icon={<FileQuestion />}
      title={t("notFound.title")}
      description={t("notFound.description")}
      contents={
        <Button asChild size="sm" variant="outline">
          <Link to="/">{t("page.backHome")}</Link>
        </Button>
      }
    />
  )
}
