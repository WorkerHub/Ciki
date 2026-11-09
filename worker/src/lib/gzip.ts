/**
 * gzip 编解码的唯一实现（规格「历史版本 gzip 存储」）。
 *
 * 只用 Workers 原生的 `CompressionStream` / `DecompressionStream`（工作线程里
 * 由运行时实现，不引第三方压缩库），经 `ReadableStream` → `Response` 取字节：
 * 不经过 Blob，也不把中间结果串成字符串。
 *
 * 落库形态是 **BLOB 原始 gzip 字节**（不是 base64 TEXT）——省掉 base64 的 33%
 * 膨胀，单条版本体积才落在正文 JSON 的 0.2–0.3 倍。
 *
 * 读侧必须容忍三种字节载体：D1 读 BLOB 可能给 `ArrayBuffer`，测试替身
 * （node:sqlite）给 `Uint8Array`，历史实现里也可能出现 `number[]`。统一先归一化，
 * 再校验 gzip 魔数 `1f 8b`——拿一段非 gzip 字节来解压要报得明白，而不是抛一个
 * 底层的 stream 错误。
 */

/** gzip 魔数：前两字节固定为 0x1f 0x8b。 */
const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/** 反序列化/解压失败（库里的字节不是合法 gzip）。 */
export class GzipError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "GzipError"
  }
}

/** 把读库得到的字节载体归一化成 Uint8Array（不改原缓冲）。 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "number") {
        throw new GzipError("Stored bytes are not a byte array")
      }
    }
    return Uint8Array.from(value as number[])
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  // ArrayBufferView 的其它形态（DataView / 其它 TypedArray）。
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  throw new GzipError("Stored bytes are not a byte buffer")
}

/** 文本 → gzip 字节。 */
export async function gzipText(text: string): Promise<Uint8Array> {
  return compress(new TextEncoder().encode(text), "gzip")
}

/** gzip 字节 → 文本。非 gzip 或不完整的数据抛 {@link GzipError}。 */
export async function gunzipText(value: unknown): Promise<string> {
  const bytes = toBytes(value)
  if (bytes.length < 2) {
    throw new GzipError("Stored revision content is truncated")
  }
  if (bytes[0] !== GZIP_MAGIC_0 || bytes[1] !== GZIP_MAGIC_1) {
    throw new GzipError("Stored revision content is not gzip data")
  }
  try {
    const decoded = await decompress(bytes, "gzip")
    return new TextDecoder().decode(decoded)
  } catch (err) {
    throw new GzipError("Stored revision content cannot be decompressed", {
      cause: err
    })
  }
}

async function compress(
  bytes: Uint8Array,
  format: "gzip"
): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  }).pipeThrough(new CompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompress(
  bytes: Uint8Array,
  format: "gzip"
): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    }
  }).pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
