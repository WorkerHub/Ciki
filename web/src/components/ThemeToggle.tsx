import { Monitor, Moon, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { THEME_STYLE_OPTIONS, type Theme, type ThemeStyle } from "@/lib/theme"
import { useThemeStore } from "@/stores/theme"

const ICONS = {
  auto: Monitor,
  light: Sun,
  dark: Moon
} as const

export interface ThemeStyleSegmentedProps {
  value: ThemeStyle
  onChange: (style: ThemeStyle) => void
  disabled?: boolean
}

/** 设置页里的主题风格选择（Nova / 纸面，极简两个选项、无说明文字）。纯受控组件，选择后由外部保存按钮写回账号。 */
export function ThemeStyleSegmented({
  value,
  onChange,
  disabled
}: ThemeStyleSegmentedProps) {
  const { t } = useTranslation()
  const safeValue: ThemeStyle = value === "paper" ? "paper" : "nova"
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={safeValue}
      disabled={disabled}
      onValueChange={(val) => {
        if (val) onChange(val as ThemeStyle)
      }}
      aria-label={t("common.theme.styleLabel")}
    >
      {THEME_STYLE_OPTIONS.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {t(option.labelKey)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** 顶栏的快捷切换：自动 → 浅色 → 深色 循环。 */
export function ThemeCycleButton() {
  const { t } = useTranslation()
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const currentTheme: Theme =
    theme === "light" || theme === "dark" ? theme : "auto"
  const Icon = ICONS[currentTheme]
  const order: Theme[] = ["auto", "light", "dark"]
  const label: Record<Theme, string> = {
    auto: t("common.theme.cycle.auto"),
    light: t("common.theme.cycle.light"),
    dark: t("common.theme.cycle.dark")
  }
  const hint = t("common.theme.cycle.switch", { label: label[currentTheme] })
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      title={hint}
      aria-label={hint}
      onClick={() => {
        const index = order.indexOf(currentTheme)
        setTheme(order[(index + 1) % order.length])
      }}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
