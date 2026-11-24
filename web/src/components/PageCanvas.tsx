import type { ReactNode } from "react"

/**
 * 文章页正文画布：阅读页与编辑页共用同一份宽度规则（规格 v1.0 §1/§2）。
 * 正文跟随内容区可用宽度，两侧只留固定边距——手机 16px、≥640px 一律 24px
 * （与系统页容器同一套边距）；封顶 1600px，到顶后居中。
 * 宽度数值只在这里定义一次，两态不各写一份。
 *
 * 画布本身不设横向裁剪（避免裁切评论区等贴边组件的聚焦环）；
 * 横向溢出裁剪下移至正文内容列包装层（如 ReadView 容器），继续兜底宽表格与代码块。
 */
export function PageCanvas({ children }: { children: ReactNode }) {
  return (
    <div className="w-full px-4 py-5 sm:px-6 sm:py-6">
      <div data-page-canvas="" className="mx-auto w-full max-w-[1600px]">
        {children}
      </div>
    </div>
  )
}
