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
