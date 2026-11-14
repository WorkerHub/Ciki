/**
 * 最小 R2 替身：按 key 存字节与 httpMetadata，get 返回带 body 的只读对象。
 *
 * 额外补了月度孤儿清理需要的东西（真实 R2 的行为对齐）：
 *   - 每个对象带 `uploaded`（默认写入时刻，测试可用 putWithUploaded 指定）；
 *   - `list()` 支持 cursor 分页，且**故意把页大小压到 2 条**，让调用方无论如何
 *     都要走多页循环——分页逻辑不能只在真 R2 上才被跑到；
 *   - `failDeleteKeys` 里的 key 删除时抛错，用来验证「单个失败不中断整轮」。
 */
export class MemoryR2 {
  readonly store = new Map<
    string,
    {
      bytes: Uint8Array
      uploaded: Date
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
      httpEtag: string
    }
  >()

  /** 这些 key 的 delete 会抛错（模拟 R2 偶发失败）。 */
  readonly failDeleteKeys = new Set<string>()

  /**
   * 单页最多返回几条。默认 2（故意小于 1000，强制调用方走分页）；
   * 体积统计的「>1000 对象多页」场景用 `new MemoryR2(1000)` 还原真实页大小。
   */
  readonly pageSize: number

  constructor(pageSize = 2) {
    this.pageSize = pageSize
  }

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  ): Promise<void> {
    this.setEntry(key, value, new Date(), options)
  }

  /** 同 put，但把 uploaded 指定成过去的时刻（30 天门槛相关测试用）。 */
  async putWithUploaded(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    uploaded: Date,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  ): Promise<void> {
    this.setEntry(key, value, uploaded, options)
  }

  private setEntry(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    uploaded: Date,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  ): void {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value)
    this.store.set(key, {
      bytes,
      uploaded,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      httpEtag: `"${key.length}-${bytes.length}"`
    })
  }

  async get(key: string) {
    const object = this.store.get(key)
    if (!object) return null
    const bytes = object.bytes
    return {
      key,
      size: bytes.length,
      uploaded: object.uploaded,
      httpEtag: object.httpEtag,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      body: new Blob([bytes]).stream(),
      // 与 R2 的 R2ObjectBody 对齐：正文既可流式读，也可整体取 ArrayBuffer。
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes)
    }
  }

  /** 与 R2 的 head 对齐：只回元数据，不下载正文（头像校验用）。 */
  async head(key: string) {
    const object = this.store.get(key)
    if (!object) return null
    return {
      key,
      size: object.bytes.length,
      uploaded: object.uploaded,
      httpEtag: object.httpEtag,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata
    }
  }

  /**
   * 分页列举：按 key 升序，`cursor` 是下一页的起点（这里直接用 key）。
   * 返回形状与 R2 的 `list()` 一致（objects / truncated / cursor）。
   */
  async list(options?: { cursor?: string; limit?: number }) {
    const keys = [...this.store.keys()].sort()
    const after = options?.cursor
    const start = after === undefined ? 0 : keys.findIndex((key) => key > after)
    const from = start === -1 ? keys.length : start
    const size = Math.min(options?.limit ?? this.pageSize, this.pageSize)
    const page = keys.slice(from, from + size)
    const truncated = from + page.length < keys.length
    return {
      objects: page.map((key) => {
        const object = this.store.get(key)
        return {
          key,
          size: object?.bytes.length ?? 0,
          uploaded: object?.uploaded ?? new Date(0),
          httpEtag: object?.httpEtag ?? `"${key.length}"`,
          httpMetadata: object?.httpMetadata,
          customMetadata: object?.customMetadata
        }
      }),
      truncated,
      cursor: truncated ? page[page.length - 1] : undefined
    }
  }

  async delete(key: string): Promise<void> {
    if (this.failDeleteKeys.has(key)) {
      throw new Error(`R2 delete failed for ${key}`)
    }
    this.store.delete(key)
  }
}
