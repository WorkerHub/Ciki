/**
 * 最小 R2 替身：按 key 存字节与 httpMetadata，get 返回带 body 的只读对象。
 */
export class MemoryR2 {
  readonly store = new Map<
    string,
    {
      bytes: Uint8Array
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
      httpEtag: string
    }
  >()

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    }
  ): Promise<void> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value)
    this.store.set(key, {
      bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      httpEtag: `"${key.length}-${bytes.length}"`
    })
  }

  async get(key: string) {
    const object = this.store.get(key)
    if (!object) return null
    return {
      key,
      size: object.bytes.length,
      httpEtag: object.httpEtag,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      body: new Blob([object.bytes]).stream()
    }
  }

  /** 与 R2 的 head 对齐：只回元数据，不下载正文（头像校验用）。 */
  async head(key: string) {
    const object = this.store.get(key)
    if (!object) return null
    return {
      key,
      size: object.bytes.length,
      httpEtag: object.httpEtag,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}
