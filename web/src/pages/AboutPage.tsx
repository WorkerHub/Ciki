import { ExternalLink, GitBranch, Info } from "lucide-react"
import { useTranslation } from "react-i18next"
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

/** 技术栈行的顺序与 id；文案在 locales 的 about.stack.rows.<row>.*。 */
const STACK_ROWS = [
  "frontend",
  "editor",
  "backend",
  "image",
  "interaction"
] as const

export function AboutPage() {
  const { t } = useTranslation()
  return (
    <div className="max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <Info className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("about.title")}
        </h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("about.intro.title")}</CardTitle>
          <CardDescription>{t("about.intro.body")}</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("about.stack.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2">
            {STACK_ROWS.map((row) => (
              <div
                key={row}
                className="grid gap-0.5 sm:grid-cols-[6rem_1fr] sm:gap-3"
              >
                <dt className="text-xs font-medium text-muted-foreground">
                  {t(`about.stack.rows.${row}.label`)}
                </dt>
                <dd className="text-sm">
                  {t(`about.stack.rows.${row}.detail`)}
                </dd>
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
            {t("about.build.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr] sm:gap-3">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("about.build.version")}
            </dt>
            <dd className="font-mono text-sm break-all">{__APP_VERSION__}</dd>
            <dt className="text-xs font-medium text-muted-foreground">
              {t("about.build.time")}
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
            {t("about.repo", { url: REPO_URL })}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </CardContent>
      </Card>
    </div>
  )
}
