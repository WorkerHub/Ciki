import { Monitor, Moon, Sun } from "lucide-react"
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
      aria-label="主题"
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = ICONS[option.value]
        return (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            title={option.hint}
          >
            <Icon aria-hidden="true" />
            {option.label}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/** 顶栏的快捷切换：自动 → 浅色 → 深色 循环。 */
export function ThemeCycleButton() {
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const Icon = ICONS[theme]
  const order: Theme[] = ["auto", "light", "dark"]
  const label: Record<Theme, string> = {
    auto: "自动（跟随系统）",
    light: "浅色",
    dark: "深色"
  }
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      title={`主题：${label[theme]}，点击切换`}
      aria-label={`主题：${label[theme]}，点击切换`}
      onClick={() => {
        const index = order.indexOf(theme)
        setTheme(order[(index + 1) % order.length])
      }}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
