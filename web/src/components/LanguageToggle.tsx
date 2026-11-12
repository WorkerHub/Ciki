import { Languages } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { changeLanguage } from "@/i18n"
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  SUPPORTED_LANGUAGES
} from "@/lib/language"

interface LanguageSwitchProps {
  /** 交给调用方接管写回（设置页要同步账号）；不传则只改本地选择。 */
  onChange?: (language: Language) => void
  disabled?: boolean
}

/**
 * 当前语言与切换动作。语言状态读 i18next（useTranslation 订阅变化），
 * 选项由支持集驱动：加语言只加资源文件和常量，不改这里。
 */
function useLanguageChoice(onChange?: (language: Language) => void) {
  const { i18n } = useTranslation()
  const value = i18n.resolvedLanguage ?? i18n.language
  const current = isLanguage(value) ? value : DEFAULT_LANGUAGE
  return {
    current,
    select: (next: Language) => {
      if (next === current) return
      if (onChange) onChange(next)
      else void changeLanguage(next)
    }
  }
}

/** 设置页里的语言选择：与「外观」的三档分段控件同款。 */
export function LanguageSegmented({ onChange, disabled }: LanguageSwitchProps) {
  const { t } = useTranslation()
  const { current, select } = useLanguageChoice(onChange)
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={current}
      disabled={disabled}
      onValueChange={(value) => {
        if (isLanguage(value)) select(value)
      }}
      aria-label={t("settings.language.label")}
    >
      {SUPPORTED_LANGUAGES.map((language) => (
        <ToggleGroupItem key={language} value={language}>
          {t(`common.languages.${language}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** 未登录页右上角的快捷切换：按支持集循环（与主题按钮同一种布局）。 */
export function LanguageCycleButton() {
  const { t } = useTranslation()
  const { current, select } = useLanguageChoice()
  const label = t("auth.language.switch", {
    language: t(`common.languages.${current}`)
  })
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      title={label}
      aria-label={label}
      onClick={() => {
        const index = SUPPORTED_LANGUAGES.indexOf(current)
        select(SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length])
      }}
    >
      <Languages aria-hidden="true" />
    </Button>
  )
}
