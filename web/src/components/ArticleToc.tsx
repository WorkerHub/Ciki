import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useMediaQuery } from "@/hooks/useMediaQuery"
import { ACTIVE_LINE, findScrollParent } from "@/lib/scroll-anchor"
import { TOC_MIN_ITEMS, type TocItem } from "@/lib/toc"
import { cn } from "@/lib/utils"

/** 断点：xl（1280px）以下整轨不渲染，正文吃满原宽度。 */
const TOC_BREAKPOINT = "(min-width: 1280px)"

interface ArticleTocProps {
  /** extractToc 的结果；空数组表示本文没有索引。 */
  items: TocItem[]
  /** 阅读态正文根元素：就绪前为 null，轨照常先渲染，锚点补齐后再挂观察器。 */
  contentRoot: HTMLElement | null
}

/**
 * 阅读页右侧悬浮索引轨：每项一行、点击走原生锚点、滚动由原生
 * IntersectionObserver 触发高亮。轨本身与正文同处一行，宽度变化与正文同帧。
 */
export function ArticleToc({ items, contentRoot }: ArticleTocProps) {
  const { t } = useTranslation()
  const wide = useMediaQuery(TOC_BREAKPOINT)
  const [activeId, setActiveId] = useState("")
  const navRef = useRef<HTMLElement>(null)

  // 观察标题：IntersectionObserver 只负责触发，当前小节按判定线实测决定，
  // 避免同一判定带里落着好几个标题时选错。只认拿到 id 的标题（空标题没有 id）。
  useEffect(() => {
    if (!wide || !contentRoot || items.length < TOC_MIN_ITEMS) return
    const Observer = window.IntersectionObserver
    if (!Observer) return

    const headings = items
      .map((item) => contentRoot.querySelector<HTMLElement>(`#${item.id}`))
      .filter((heading): heading is HTMLElement => heading !== null)
    if (headings.length === 0) return

    const scrollRoot = findScrollParent(contentRoot)
    let frame = 0
    let pending = false

    const measure = () => {
      const line = (scrollRoot?.getBoundingClientRect().top ?? 0) + ACTIVE_LINE
      let next = headings[0]?.id ?? ""
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= line + 1) next = heading.id
      }
      if (next) setActiveId(next)
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

    const observer = new Observer(schedule, {
      root: scrollRoot,
      rootMargin: `-${ACTIVE_LINE}px 0px -70% 0px`
    })
    for (const heading of headings) observer.observe(heading)

    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [wide, contentRoot, items])

  // 换文章（或换渲染根）时回到第一项：上一页的 activeId 在新文档里位置式同名，
  // 不重置就会在新页顶部直接高亮上一页的中间小节，等观察器回调才纠正。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 items/contentRoot 换新时重置，当前项随后由观察器回调补回
  useEffect(() => {
    setActiveId("")
  }, [items, contentRoot])

  // 当前项始终留在轨的可视区内：只动轨自己的滚动，不惊动页面主滚动。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId 只是「高亮换了」的触发器，元素从 DOM 取
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!nav || !active) return
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < nav.scrollTop) nav.scrollTop = top
    else if (bottom > nav.scrollTop + nav.clientHeight)
      nav.scrollTop = bottom - nav.clientHeight
  }, [activeId])

  if (!wide || items.length < TOC_MIN_ITEMS) return null

  // 缩进以本文最浅层级为基准：全是 2 级起的文档，2 级项不缩进。
  const baseLevel = Math.min(...items.map((item) => item.level))
  const current = items.some((item) => item.id === activeId)
    ? activeId
    : items[0].id

  return (
    <aside className="ml-8 w-56 shrink-0">
      <nav
        ref={navRef}
        aria-label={t("page.toc.label")}
        className="sticky top-6 max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain"
      >
        <ul className="space-y-0.5 text-xs leading-5">
          {items.map((item) => {
            const active = item.id === current
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  title={item.text}
                  aria-current={active ? "location" : undefined}
                  onClick={() => setActiveId(item.id)}
                  style={{
                    paddingInlineStart: `${8 + (item.level - baseLevel) * 12}px`
                  }}
                  className={cn(
                    "block truncate rounded-sm py-1 pr-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    active
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.text}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
