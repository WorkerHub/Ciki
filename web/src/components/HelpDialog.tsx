import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

/** 支持矩阵的行 id；文案在 locales 的 help.supported.rows.<row>.*。 */
const SUPPORTED_ROWS = [
  "headings",
  "codeBlock",
  "table",
  "list",
  "inline",
  "image",
  "attachment"
] as const

/**
 * 应用内帮助：粘贴支持矩阵 + 已知限制（规格 §5 要求写在帮助文案里）。
 * 入口已经收进头像菜单，弹窗本身受控，由 UserMenu 打开。
 */
export function HelpDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("help.title")}</DialogTitle>
          <DialogDescription>{t("help.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section className="space-y-2">
            <h3 className="font-medium">{t("help.supported.title")}</h3>
            <ul className="space-y-1.5">
              {SUPPORTED_ROWS.map((row) => (
                <li
                  key={row}
                  className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-6"
                >
                  <span>{t(`help.supported.rows.${row}.item`)}</span>
                  <span className="text-muted-foreground sm:text-right">
                    {t(`help.supported.rows.${row}.detail`)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
            <h3 className="font-medium">{t("help.limits.title")}</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("help.limits.tableHeader")}</li>
              <li>{t("help.limits.colors")}</li>
              <li>{t("help.limits.panels")}</li>
            </ul>
          </section>

          <section className="space-y-1 text-muted-foreground">
            <p>{t("help.shortcuts.save")}</p>
            <p>{t("help.shortcuts.versions")}</p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
