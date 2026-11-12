/**
 * R2 桶体积口径：用现有绑定分页 `list()` 累加对象 `size`（字节）。
 *
 * 为什么不走 Cloudflare 分析 API：管理页要的是「这两个桶现在多大」，绑定上的
 * `list()` 就是权威数据源（与桶里真实对象逐一对得上），不必再引入一份令牌权限与
 * 统计延迟。两个桶各自独立统计（图片 `ciki-assets` / 正文 `ciki-content`），不合并。
 *
 * 分页：每页 1000（Cloudflare 的上限），循环到 `truncated: false` 为止；累加同时
 * 记对象数（本期前端不显示，留给后续口径）。防死循环：截断页必须给出**未见过的新
 * 游标**，游标缺失、原地踏步或回到见过的值一律判失败——绝不空转，也不返回半截求和。
 *
 * 降级形状与 `src/core/d1-size.ts` 一致：失败一律回
 * `{ bytes: null, objectCount: null, measure: "unavailable" }`，**绝不估算**，
 * 调用方与前端据此不渲染该项。不加缓存、不加定时任务：管理页低频打开时现算
 * （当前量级毫秒级）。
 */
const LIST_PAGE_SIZE = 1000

export interface BucketSize {
  /** 桶内对象 `size` 之和（字节）；统计失败为 `null`。 */
  bytes: number | null
  /** 与 `bytes` 同生共死的对象数；统计失败为 `null`。 */
  objectCount: number | null
  /** 体积来源：`list()` 逐页累加成功为 `r2-list`，失败为 `unavailable`。 */
  measure: "r2-list" | "unavailable"
}

/** 与 `core/bucket-cleanup.ts` 同一口径：读不出可用 size 的对象按 0 计，不因此整桶失败。 */
function sizeOf(object: R2Object): number {
  const size = object.size
  return Number.isFinite(size) && size > 0 ? size : 0
}

function unavailable(): BucketSize {
  return { bytes: null, objectCount: null, measure: "unavailable" }
}

/**
 * 统计一个桶的总字节数与对象数。任一页失败（含游标不前进的死循环防护）整桶降级，
 * 不把已扫到的那部分当作总体积——半截数字比「不可得」更容易骗人。
 */
export async function readBucketSize(bucket: R2Bucket): Promise<BucketSize> {
  let bytes = 0
  let objectCount = 0
  let cursor: string | undefined
  // 见过的游标：R2 的游标是不透明字符串，只认「新且没见过」，防原地踏步与来回跳。
  const seen = new Set<string>()

  try {
    for (;;) {
      const page = await bucket.list({ limit: LIST_PAGE_SIZE, cursor })
      for (const object of page.objects) {
        objectCount += 1
        bytes += sizeOf(object)
      }
      if (!page.truncated) break

      const next = page.cursor
      if (
        typeof next !== "string" ||
        next.length === 0 ||
        next === cursor ||
        seen.has(next)
      ) {
        console.warn("R2 bucket size listing did not advance the cursor")
        return unavailable()
      }
      seen.add(next)
      cursor = next
    }
  } catch (err) {
    console.warn(
      "R2 bucket size listing failed:",
      err instanceof Error ? err.message : String(err)
    )
    return unavailable()
  }

  return { bytes, objectCount, measure: "r2-list" }
}
