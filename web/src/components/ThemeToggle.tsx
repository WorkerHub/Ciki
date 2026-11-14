import { Monitor, Moon, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { THEME_OPTIONS, type Theme } from "@/lib/theme"
import { useThemeStore } from "@/stores/theme"

const ICONS = {
  auto: Monitor,
  light: Sun,
  dark: Moon
} as const

/** 设置页里的三档选择（明示「自动」的含义）。 */
export function ThemeSegmented() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={theme}
      onValueChange={(value) => {
        if (value) setTheme(value as Theme)
      }}
      aria-label={t("common.theme.label")}
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = ICONS[option.value]
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            title={t(option.hintKey)}
          >
            <Icon aria-hidden="true" />
            {t(option.labelKey)}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/** 顶栏的快捷切换：自动 → 浅色 → 深色 循环。 */
export function ThemeCycleButton() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const Icon = ICONS[theme]
  const order: Theme[] = ["auto", "light", "dark"]
  const label: Record<Theme, string> = {
    auto: t("common.theme.cycle.auto"),
    light: t("common.theme.cycle.light"),
    dark: t("common.theme.cycle.dark")
  }
  const hint = t("common.theme.cycle.switch", { label: label[theme] })
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      title={hint}
      aria-label={hint}
      onClick={() => {
        const index = order.indexOf(theme)
        setTheme(order[(index + 1) % order.length])
      }}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
