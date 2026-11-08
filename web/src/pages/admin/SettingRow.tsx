import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

/** 系统管理里「开关 + 说明」的统一行高与排版。 */
export function SettingRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="max-w-prose text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  )
}

/** 「文本框 + 说明」行：Enter/失焦保存，Esc 还原，空值交给调用方拦。 */
export function SettingTextRow({
  label,
  description,
  value,
  maxLength,
  disabled,
  onSave
}: {
  label: string
  description: string
  value: string
  maxLength?: number
  disabled?: boolean
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = () => {
    const next = draft.trim()
    if (!next || next === value) {
      setDraft(value)
      return
    }
    onSave(next)
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="max-w-prose text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Input
        value={draft}
        maxLength={maxLength}
        disabled={disabled}
        aria-label={label}
        className="h-8 w-full sm:w-56"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            setDraft(value)
          }
        }}
      />
    </div>
  )
}
