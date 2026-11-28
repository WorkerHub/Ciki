import { ApiError } from "@/lib/api"

export class AbortError extends Error {
  constructor(message = "Operation aborted") {
    super(message)
    this.name = "AbortError"
  }
}

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  signal?: AbortSignal
}

/**
 * 带有 429/5xx 指数退避重试的执行器：
 * - 401/403 立即中止并抛出错误
 * - 429/5xx 进行指数退避（至多 3 次）
 * - 支持 signal 及时取消
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 500, signal } = options

  let attempt = 0
  while (true) {
    if (signal?.aborted) {
      throw new AbortError()
    }

    try {
      return await fn()
    } catch (error) {
      attempt++
      if (signal?.aborted) {
        throw new AbortError()
      }

      // 401 / 403 立即中止，不重试
      if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
          throw error
        }
        const isRetryable = error.status === 429 || error.status >= 500
        if (!isRetryable || attempt > maxRetries) {
          throw error
        }
      } else {
        // 网络错误等其它异常
        if (attempt > maxRetries) {
          throw error
        }
      }

      // 计算退避时间 (exponential + random jitter)
      const delay =
        initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 200
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
            reject(new AbortError())
          }
          signal.addEventListener("abort", onAbort)
        }
      })
    }
  }
}

/**
 * 控制最大并发数 ≤ limit 执行一批异步任务
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  limit = 4,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      if (signal?.aborted) {
        throw new AbortError()
      }
      const currentIndex = nextIndex++
      const item = items[currentIndex]
      results[currentIndex] = await worker(item, currentIndex)
    }
  }

  const workerCount = Math.min(limit, items.length)
  const pool: Promise<void>[] = []
  for (let i = 0; i < workerCount; i++) {
    pool.push(runWorker())
  }

  await Promise.all(pool)
  return results
}
