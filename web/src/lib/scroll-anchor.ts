/**
 * 阅读⇄编辑的位置保持：以「判定线上最近的顶层块（标题或段落）」为锚。
 *
 * 阅读页与编辑页是两个独立路由，切换时正文会重挂、滚动位置被夹走。两态渲染的是
 * 同一份文档（编辑态吃 contentJson、阅读态吃同一份 contentJson 生成并消毒过的
 * contentHtml，扩展集相同），所以正文根元素的顶层块一一对应：记下「第几块 + 块内
 * 比例」，另一态就能把同一块送回同一条判定线，误差不超过一个块高——远小于一屏。
 *
 * 位置本身不放 URL、不进全局 store：单条记在 sessionStorage（按 pageId 校验），
 * 刷新编辑页也能复位；阅读页消费后即删，不会在以后的普通访问里复活。
 */

/** 判定线相对滚动容器顶部的偏移，与索引轨高亮同一口径（阅读、编辑两态共用）。 */
export const ACTIVE_LINE = 24

/** 位置锚：正文根元素里第 blockIndex 个顶层块，块内比例 ratio（0–1）。 */
export interface ScrollAnchor {
  blockIndex: number
  ratio: number
}

/** 存储键：只保留一条，带 pageId 校验（换页时旧锚点自动作废）。 */
const STORAGE_KEY = "ciki-scroll-anchor"

interface StoredAnchor extends ScrollAnchor {
  pageId: number
}

/** 正文/标题的最近滚动祖先：位置保持跟主区走，不以窗口为准。 */
export function findScrollParent(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === "auto" || overflowY === "scroll") return current
    current = current.parentElement
  }
  return null
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, 1)
}

function rectOf(element: Element): DOMRect {
  return element.getBoundingClientRect()
}

/**
 * 记下当前滚动位置落在哪一块上。
 * 没有滚动（短文）、没有滚动容器、正文不在文档里时返回 null —— 调用方据此完全不
 * 记忆，短文的行为与改动前一致。
 */
export function captureScrollAnchor(root: HTMLElement): ScrollAnchor | null {
  if (!root.isConnected || root.children.length === 0) return null
  const scrollParent = findScrollParent(root)
  if (!scrollParent || scrollParent.scrollTop <= 0) return null

  const line = rectOf(scrollParent).top + ACTIVE_LINE
  let blockIndex = 0
  for (let index = 0; index < root.children.length; index += 1) {
    if (rectOf(root.children[index]).top <= line + 1) blockIndex = index
  }
  const rect = rectOf(root.children[blockIndex])
  return {
    blockIndex,
    ratio: rect.height > 0 ? clampRatio((line - rect.top) / rect.height) : 0
  }
}

/**
 * 把锚点块送回判定线。`inset` 是判定线上方被固定层遮住的高度（编辑态的吸顶工具条）。
 * 找不到锚点（正文未挂载、块序号越界、没有滚动容器）时一律不滚动、返回 false：
 * 调用方的行为就是「回到顶部」，不报错、不白屏。
 *
 * 直接写 `scrollTop` 而不用 scrollIntoView：后者会把块顶对齐容器顶，丢掉块内比例，
 * 而且受 CSS 平滑滚动影响。
 */
export function restoreScrollAnchor(
  root: HTMLElement,
  anchor: ScrollAnchor,
  inset = 0
): boolean {
  if (!root.isConnected) return false
  const block = root.children[anchor.blockIndex]
  if (!block) return false
  const scrollParent = findScrollParent(root)
  if (!scrollParent) return false

  const line = rectOf(scrollParent).top + ACTIVE_LINE + inset
  const rect = rectOf(block)
  scrollParent.scrollTop +=
    rect.top + clampRatio(anchor.ratio) * rect.height - line
  return true
}

function readStored(pageId: number): ScrollAnchor | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredAnchor> | null
    if (!value || value.pageId !== pageId) return null
    const blockIndex = value.blockIndex
    if (typeof blockIndex !== "number" || !Number.isInteger(blockIndex)) {
      return null
    }
    if (blockIndex < 0) return null
    return { blockIndex, ratio: clampRatio(Number(value.ratio)) }
  } catch {
    /* 存的是脏数据或 storage 不可用：当作没有锚点 */
    return null
  }
}

/** 记下（或清除）某个页面的位置锚。`null` 表示这一页没有值得记的位置。 */
export function rememberScrollAnchor(
  pageId: number,
  anchor: ScrollAnchor | null
): void {
  try {
    if (!anchor) {
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }
    const payload: StoredAnchor = {
      pageId,
      blockIndex: anchor.blockIndex,
      ratio: clampRatio(anchor.ratio)
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* storage 不可用：位置保持退化为「回到顶部」，不影响编辑与保存 */
  }
}

/** 读某个页面的位置锚（不删除）：编辑页进来时用，返回阅读时还要用同一条。 */
export function readScrollAnchor(pageId: number): ScrollAnchor | null {
  return readStored(pageId)
}

/** 读并删除：阅读页恢复后即用掉，之后的普通访问不会复活旧位置。 */
export function takeScrollAnchor(pageId: number): ScrollAnchor | null {
  const anchor = readStored(pageId)
  if (!anchor) return null
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage 不可用：内存里也没有可留的东西 */
  }
  return anchor
}
