import { ArrowUp } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { findScrollParent } from "@/lib/scroll-anchor"
import { cn } from "@/lib/utils"

export interface BackToTopProps {
  /**
   * 判定滚动容器的参照元素（如阅读页正文根元素 contentRoot）。
   * 若传入，以此向上寻找最近的 overflow-y 滚动容器；若未传，则以本组件探测节点向上寻找。
   */
  contentRoot?: HTMLElement | null
  /**
   * 直接指定的滚动容器（可选，用于单测或已知固定容器场景）。若指定则优先使用。
   */
  scrollContainer?: HTMLElement | null
  className?: string
}

function resolveScrollContainer(
  contentRoot?: HTMLElement | null,
  scrollContainer?: HTMLElement | null,
  fallbackNode?: HTMLElement | null
): HTMLElement | null {
  if (scrollContainer) return scrollContainer
  if (contentRoot) {
    const selfOverflow = getComputedStyle(contentRoot).overflowY
    if (selfOverflow === "auto" || selfOverflow === "scroll") {
      return contentRoot
    }
    const parent = findScrollParent(contentRoot)
    if (parent) return parent
  }
  if (fallbackNode) {
    return findScrollParent(fallbackNode)
  }
  return null
}

/**
 * 回到顶部按钮：长文档下滑过一屏（scrollTop > clientHeight）右下角淡入，
 * 点击平滑回顶（scrollTop = 0），回到阈值内淡出；短页面永不出现。
 */
export function BackToTop({
  contentRoot,
  scrollContainer,
  className
}: BackToTopProps) {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const markerRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const scrollRootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const scrollRoot = resolveScrollContainer(
      contentRoot,
      scrollContainer,
      markerRef.current
    )
    scrollRootRef.current = scrollRoot

    if (!scrollRoot) {
      setVisible(false)
      return
    }

    let frame = 0
    let pending = false

    const measure = () => {
      const root = scrollRootRef.current
      if (!root) {
        setVisible(false)
        return
      }
      const { scrollTop, clientHeight, scrollHeight } = root
      // 短文无滚动：scrollHeight <= clientHeight 永不出现
      // 长页面：下滑超过一屏（scrollTop > clientHeight）淡入；回到阈值内（scrollTop <= clientHeight）淡出
      const shouldShow = scrollHeight > clientHeight && scrollTop > clientHeight
      setVisible(shouldShow)
    }

    const schedule = () => {
      if (pending) return
      pending = true
      if (typeof window.requestAnimationFrame !== "function") {
        pending = false
        measure()
        return
      }
      frame = window.requestAnimationFrame(() => {
        pending = false
        frame = 0
        measure()
      })
    }

    // 初次挂载或容器就绪时立即同步测量一次
    measure()

    scrollRoot.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule, { passive: true })

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        schedule()
      })
      resizeObserver.observe(scrollRoot)
      if (contentRoot) {
        resizeObserver.observe(contentRoot)
      }
    }

    return () => {
      scrollRoot.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
      if (frame) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [contentRoot, scrollContainer])

  const scrollToTop = () => {
    const root = scrollRootRef.current
    if (!root) return
    const isReduced =
      Boolean(reduceMotion) ||
      (typeof window !== "undefined" &&
        Boolean(
          window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
        ))
    const behavior = isReduced ? "auto" : "smooth"
    if (typeof root.scrollTo === "function") {
      root.scrollTo({ top: 0, behavior })
    } else {
      root.scrollTop = 0
    }
  }

  return (
    <>
      <span ref={markerRef} className="sr-only" aria-hidden="true" />
      <AnimatePresence>
        {visible && (
          <motion.button
            type="button"
            aria-label={t("page.backToTop")}
            onClick={scrollToTop}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "fixed z-30 flex size-10 items-center justify-center rounded-full",
              "border border-border/60 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm",
              "hover:bg-background/95 hover:text-foreground hover:shadow-md",
              "active:scale-95 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(1.25rem+env(safe-area-inset-bottom))]",
              "sm:right-8 sm:bottom-8",
              className
            )}
          >
            <ArrowUp className="size-5 shrink-0" aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  )
}
