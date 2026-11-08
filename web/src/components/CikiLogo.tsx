import { cn } from "cn"

/**
 * 品牌标记：文档轮廓 + 开口的字母 C。
 * 用 currentColor，品牌区/登录页在浅色与深色主题下自动取前景色。
 */
export function CikiLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
    >
      <path
        d="M6.25 2.75h8.1l5.4 5.4V20a1.25 1.25 0 0 1-1.25 1.25H6.25A1.25 1.25 0 0 1 5 20V4a1.25 1.25 0 0 1 1.25-1.25Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M14.1 2.9v5.6h5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M15.1 12.4a3.9 3.9 0 1 0 0 5.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
