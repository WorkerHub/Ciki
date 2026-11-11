import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { type CommentList, commentsApi, describeApiError } from "@/lib/api"

export type CommentsStatus = "loading" | "ready" | "error"

/**
 * 页尾评论的数据层：整页一次取回（契约不分页），任何变更后重拉同一个列表。
 *
 * 「就地刷新该串」就是重新 GET 一次：total、editedAt、软删占位与 canEdit/canDelete
 * 都由服务端算，前端不另存一份可能对不上的状态（也不做乐观更新）。
 * 变更失败用 toast 报错并把 false 交回调用方——表单与草稿保持原样，可以重试。
 */
export function useComments(pageId: string) {
  const [data, setData] = useState<CommentList | null>(null)
  const [status, setStatus] = useState<CommentsStatus>("loading")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  // 每次请求领一个号：切页、并发刷新与卸载都靠它丢弃过期响应
  // （卸载时把号推进一步，在途请求回来就不再落地，不需要第二个旗标）
  const seq = useRef(0)
  const pendingRef = useRef(false)

  useEffect(
    () => () => {
      seq.current += 1
    },
    []
  )

  const reload = useCallback(async () => {
    const mine = ++seq.current
    // 已有内容时刷新不退回骨架屏：正文与列表原地换掉
    setStatus((prev) => (prev === "ready" ? prev : "loading"))
    // 重试时先把上一条报错收起来，失败再重新给出
    setError("")
    try {
      const list = await commentsApi.list(pageId)
      if (mine !== seq.current) return
      setData(list)
      setStatus("ready")
    } catch (loadError: unknown) {
      if (mine !== seq.current) return
      setStatus("error")
      setError(describeApiError(loadError))
    }
  }, [pageId])

  useEffect(() => {
    void reload()
  }, [reload])

  const mutate = useCallback(
    async (run: () => Promise<unknown>) => {
      if (pendingRef.current) return false
      pendingRef.current = true
      setPending(true)
      try {
        await run()
        await reload()
        return true
      } catch (mutationError: unknown) {
        toast.error(describeApiError(mutationError))
        return false
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    },
    [reload]
  )

  const create = useCallback(
    (bodyMd: string, parentId?: string | null) =>
      mutate(() => commentsApi.create(pageId, { bodyMd, parentId })),
    [mutate, pageId]
  )

  const update = useCallback(
    (commentId: string, bodyMd: string) =>
      mutate(() => commentsApi.update(pageId, commentId, bodyMd)),
    [mutate, pageId]
  )

  const remove = useCallback(
    (commentId: string) => mutate(() => commentsApi.remove(pageId, commentId)),
    [mutate, pageId]
  )

  return { data, status, error, pending, reload, create, update, remove }
}
