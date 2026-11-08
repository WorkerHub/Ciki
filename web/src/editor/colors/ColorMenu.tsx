import { cn } from "cn"
import { Check, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import type { ColorOption } from "@/editor/colors/palette"

/**
 * 取色弹层：一组预设色块 + 「清除」，没有说明文案。
 * 复用工具条表格菜单同一个 DropdownMenu，键盘可达、选中即关，不另造一套弹层。
 */
export function ColorMenu({
  label,
  icon: Icon,
  colors,
  activeColor,
  onPick
}: {
  label: string
  icon: LucideIcon
  colors: ColorOption[]
  activeColor: string | null
  onPick: (color: string | null) => void
}) {
  const swatches = colors.filter((option) => option.value)
  const clearOption = colors.find((option) => !option.value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant={activeColor ? "secondary" : "ghost"}
          aria-label={label}
          title={label}
          className="relative"
        >
          <Icon aria-hidden="true" />
          <span
            aria-hidden="true"
            className="absolute inset-x-1.5 bottom-0.5 h-0.5 rounded-full"
            style={{ backgroundColor: activeColor ?? "transparent" }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-0 p-1.5">
        <div className="grid grid-cols-4 gap-1">
          {swatches.map((option) => (
            <DropdownMenuItem
              key={option.name}
              aria-label={option.name}
              title={option.name}
              onSelect={() => onPick(option.value)}
              className={cn(
                "relative size-6 items-center justify-center rounded-md border border-border p-0",
                activeColor === option.value && "ring-2 ring-ring ring-offset-1"
              )}
            >
              <span
                aria-hidden="true"
                className="size-full rounded-[inherit]"
                style={{ backgroundColor: option.value ?? "transparent" }}
              />
              {activeColor === option.value ? (
                <Check
                  aria-hidden="true"
                  className="absolute text-foreground mix-blend-difference"
                />
              ) : null}
            </DropdownMenuItem>
          ))}
        </div>
        {clearOption ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              aria-label={clearOption.name}
              onSelect={() => onPick(null)}
            >
              {clearOption.name}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
