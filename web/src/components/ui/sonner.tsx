"use client"

import type * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useThemeStore } from "@/stores/theme"

/**
 * 全局轻提示（shadcn 标准 sonner 封装）：用于「删除成功」这类瞬时结果，
 * 不进文档流、不挤动列表。明暗跟随站内主题解析后的实际值，配色复用 shadcn 令牌。
 */
function Toaster({ ...props }: ToasterProps) {
  const resolved = useThemeStore((state) => state.resolved)
  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)"
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
