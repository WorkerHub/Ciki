import type { ReactNode } from "react"

/**
 * 文章页正文画布：阅读页与编辑页共用同一份宽度规则（规格 v1.0 §1/§2）。
 * 正文跟随内容区可用宽度，两侧只留固定边距——桌面 48px、平板 24px、手机 16px；
 * 封顶 1600px，到顶后居中。宽度数值只在这里定义一次，两态不各写一份。
 *
 * overflow-x-clip 只兜住页面级横向溢出：宽表格与代码块在各自容器内滚动，
 * 不应把滚动条带到主区上。
 */
export function PageCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="w-full px-4 py-5 sm:px-6 sm:py-6 lg:px-12">
      <div
        data-page-canvas=""
        className="mx-auto w-full max-w-[1600px] overflow-x-clip"
      >
        {children}
      </div>
    </div>
  )
}
