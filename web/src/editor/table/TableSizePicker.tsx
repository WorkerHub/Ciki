import { cn } from "cn"
import { type KeyboardEvent, useCallback, useRef, useState } from "react"

/** 网格选择器的上限：15 列 × 20 行（定版）。 */
export const MAX_TABLE_COLS = 15
export const MAX_TABLE_ROWS = 20

interface TableSize {
  rows: number
  cols: number
}

const DEFAULT_SIZE: TableSize = { rows: 3, cols: 3 }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 表格网格选择器：悬停/键盘位置决定高亮区域，底部计数与之同源。
 * 键盘路径——唯一的 Tab 停靠点就是当前选中格（roving tabIndex），
 * 方向键移动、Enter/Space 走按钮原生点击插入，Esc 交给弹层关闭。
 */
export function TableSizePicker({
  onPick
}: {
  /** 按 1 起的实际行列数回调：rows 含表头行 */
  onPick: (rows: number, cols: number) => void
}) {
  const [selection, setSelection] = useState<TableSize>(DEFAULT_SIZE)
  const gridRef = useRef<HTMLDivElement>(null)

  const moveTo = useCallback((next: TableSize) => {
    setSelection(next)
    gridRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-cell="${next.rows}-${next.cols}"]`
      )
      ?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step =
      event.key === "ArrowRight"
        ? { rows: 0, cols: 1 }
        : event.key === "ArrowLeft"
          ? { rows: 0, cols: -1 }
          : event.key === "ArrowDown"
            ? { rows: 1, cols: 0 }
            : event.key === "ArrowUp"
              ? { rows: -1, cols: 0 }
              : null
    if (!step) return
    event.preventDefault()
    moveTo({
      rows: clamp(selection.rows + step.rows, 1, MAX_TABLE_ROWS),
      cols: clamp(selection.cols + step.cols, 1, MAX_TABLE_COLS)
    })
  }

  return (
    <div className="space-y-1.5">
      {/* 容器只负责排布；方向键挂在格子上（焦点永远落在唯一的 Tab 停靠点，也就是当前格） */}
      <div
        ref={gridRef}
        className="grid grid-cols-[repeat(15,0.875rem)] gap-0.5"
      >
        {Array.from({ length: MAX_TABLE_ROWS }, (_, rowIndex) =>
          Array.from({ length: MAX_TABLE_COLS }, (_, colIndex) => {
            const row = rowIndex + 1
            const col = colIndex + 1
            const selected = row <= selection.rows && col <= selection.cols
            const active = row === selection.rows && col === selection.cols
            return (
              <button
                key={`${row}-${col}`}
                type="button"
                data-cell={`${row}-${col}`}
                data-selected={selected ? "true" : undefined}
                aria-label={`${col} 列 × ${row} 行`}
                tabIndex={active ? 0 : -1}
                onKeyDown={onKeyDown}
                onMouseEnter={() => setSelection({ rows: row, cols: col })}
                onFocus={() => setSelection({ rows: row, cols: col })}
                onClick={() => onPick(row, col)}
                className={cn(
                  "size-3.5 rounded-[3px] border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-ring bg-accent"
                    : "border-border hover:border-ring"
                )}
              />
            )
          })
        )}
      </div>
      <div
        aria-live="polite"
        className="text-center text-xs text-muted-foreground tabular-nums"
      >
        {selection.cols} × {selection.rows}
      </div>
    </div>
  )
}
