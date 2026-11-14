/**
 * 流式 zip 组装（规格 v1.0 §7）：用 fflate 的流式 `Zip` 逐条写入，边读 R2 边往响应里
 * 吐字节——不把整包（更不把整图）先读进内存。
 *
 * 为什么是这个形状：
 * - **不手搓 zip**：条目头、CRC、数据描述符、中央目录全交给 fflate；这里只负责把
 *   上游的字节流按块喂进去，并把 fflate 吐出的块交给响应。
 * - **条目是 Unix 语义**（`os = 3` + 0644）：默认的 DOS 语义会让 macOS 系统 unzip
 *   按 DOS 代码页解码中文名而解压失败，见 {@link createEntry}。
 * - **图片不压缩**：png/jpg/gif/webp 已经是压缩格式，`ZipPassThrough`（store）一次
 *   搬运即可，省 CPU 也省内存；zip 内的 MD 是文本，用 `ZipDeflate` 压一道。
 * - **背压**：fflate 的 `Zip` 是同步回调，喂多快就吐多快。这里用一个带字节水位的小
 *   队列：超过 {@link HIGH_WATER_BYTES} 就让上游停手等消费端拉走，因此任意时刻内存里
 *   只有「水位 + 一块」的数据，与包的总体积无关。
 *
 * 组装从第一次 `pull` 才开始（没人读就不碰 R2）；消费端取消时上游的 R2 流一并取消。
 */
import { Zip, ZipDeflate, ZipPassThrough } from "fflate"

/** 队列字节水位：攒到这么多就先停下等消费端拉取（约几块 64KB 的量级）。 */
const HIGH_WATER_BYTES = 1 << 20

const EMPTY = new Uint8Array(0)

/** 条目的宿主系统：3 = Unix（zip 规范里中央目录「version made by」的高字节）。 */
const ZIP_HOST_UNIX = 3

/**
 * 条目权限位：普通文件 0644（Unix 语义，左移 16 位才是 zip 的外部属性字段）。
 * 与上面的 `os = 3` 必须成对出现：只给权限不给宿主系统，解压方仍按 DOS 语义读。
 */
const ZIP_FILE_ATTRS = 0o644 << 16

/**
 * 建条目并把宿主系统/权限说清楚。
 *
 * fflate 的默认是 `os = 0`（MS-DOS）、`attrs = 0`：条目名虽然已经带 UTF-8 标志位
 * （bit 11），Info-ZIP 仍会按 DOS 代码页解码文件名——macOS 的系统 `/usr/bin/unzip`
 * 因此把中文标题的 `.md` 当成非法 UTF-8、APFS 拒绝创建（实测退出码 50，与孤儿验证
 * 单 #72 一致）。置成 Unix 语义后同一个包在 macOS 系统 unzip / Finder 里都能正确
 * 解出中文名；UTF-8 标志位由 fflate 按名字内容自己置位，这里不动它。
 */
function createEntry<T extends ZipPassThrough | ZipDeflate>(entry: T): T {
  entry.os = ZIP_HOST_UNIX
  entry.attrs = ZIP_FILE_ATTRS
  return entry
}

/** 能接收字节的条目（`ZipPassThrough` 与 `ZipDeflate` 的公共形状）。 */
interface ZipEntrySink {
  push(chunk: Uint8Array, final: boolean): void
}

/** 组装期的写入口：按包的写入顺序逐个追加条目。 */
export interface ZipHandle {
  /** 追加一条按块流式写入的条目（图片）。 */
  addBinary(name: string, body: ReadableStream<Uint8Array>): Promise<void>
  /** 追加一条内存里已有的文本条目（zip 内的 MD）。 */
  addText(name: string, text: string): Promise<void>
}

/**
 * 生产者 → 消费者的小队列：单生产者（组装流程）、单消费者（响应流），所以唤醒位
 * 各留一个就够。任何一次失败或取消都把等待方立刻唤醒，绝不留悬挂的 Promise。
 */
class ChunkQueue {
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private finished = false
  private failure: unknown = null
  private cancelled = false
  private wakeConsumer: (() => void) | null = null
  private wakeProducer: (() => void) | null = null

  push(chunk: Uint8Array): void {
    if (this.cancelled || chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
    this.callWakeConsumer()
  }

  finish(): void {
    this.finished = true
    this.callWakeConsumer()
    this.callWakeProducer()
  }

  fail(error: unknown): void {
    this.failure ??= error
    this.callWakeConsumer()
    this.callWakeProducer()
  }

  cancel(): void {
    this.cancelled = true
    this.finish()
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  /** 下一块；没有就等，队列结束（或取消）给 null，失败则抛出。 */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.failure !== null) throw this.failure
      const chunk = this.chunks.shift()
      if (chunk) {
        this.bytes -= chunk.byteLength
        this.callWakeProducer()
        return chunk
      }
      if (this.finished) return null
      await new Promise<void>((resolve) => {
        this.wakeConsumer = resolve
      })
    }
  }

  /** 队列积压到水位以下才放行（生产端的背压点）。 */
  async waitUnder(limit: number): Promise<void> {
    while (!this.cancelled && this.failure === null && this.bytes >= limit) {
      await new Promise<void>((resolve) => {
        this.wakeProducer = resolve
      })
    }
    if (this.failure !== null) throw this.failure
  }

  private callWakeConsumer(): void {
    const wake = this.wakeConsumer
    this.wakeConsumer = null
    wake?.()
  }

  private callWakeProducer(): void {
    const wake = this.wakeProducer
    this.wakeProducer = null
    wake?.()
  }
}

/**
 * 组装一个 zip 响应体：`build` 在第一次 `pull` 时开跑，逐条 `addBinary` / `addText`，
 * 返回即 `zip.end()`（中央目录随最后一块吐出）。
 */
export function zipStream(
  build: (zip: ZipHandle) => Promise<void>
): ReadableStream<Uint8Array> {
  const queue = new ChunkQueue()
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      queue.fail(error)
      return
    }
    queue.push(chunk)
    if (final) queue.finish()
  })

  const write = async (
    entry: ZipEntrySink,
    chunk: Uint8Array,
    final: boolean
  ): Promise<void> => {
    await queue.waitUnder(HIGH_WATER_BYTES)
    if (queue.isCancelled) return
    entry.push(chunk, final)
  }

  /** 把上游字节流按块喂给条目；最后一块带 final，空流也照样收尾。 */
  const pipe = async (
    entry: ZipEntrySink,
    body: ReadableStream<Uint8Array>
  ): Promise<void> => {
    const reader = body.getReader()
    try {
      let chunk = await reader.read()
      if (chunk.done) {
        await write(entry, EMPTY, true)
        return
      }
      while (!chunk.done) {
        const next = await reader.read()
        await write(entry, chunk.value, next.done)
        if (queue.isCancelled) {
          // 消费端已经不在了：上游也别读了。
          await reader.cancel().catch(() => undefined)
          return
        }
        chunk = next
      }
    } catch (error) {
      // 组装到一半失手（R2 读错、消费端取消）：别把上游流晾着。
      await reader.cancel(error).catch(() => undefined)
      throw error
    }
  }

  const handle: ZipHandle = {
    async addBinary(name, body) {
      if (queue.isCancelled) return
      const entry = createEntry(new ZipPassThrough(name))
      zip.add(entry)
      await pipe(entry, body)
    },
    async addText(name, text) {
      if (queue.isCancelled) return
      const entry = createEntry(new ZipDeflate(name))
      zip.add(entry)
      await write(entry, new TextEncoder().encode(text), true)
    }
  }

  let started = false
  const run = async (): Promise<void> => {
    try {
      await build(handle)
      if (queue.isCancelled) {
        zip.terminate()
        return
      }
      zip.end()
    } catch (error) {
      queue.fail(error)
      zip.terminate()
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true
        void run()
      }
      let chunk: Uint8Array | null
      try {
        chunk = await queue.next()
      } catch (error) {
        controller.error(error)
        return
      }
      // 消费端已经取消（连接断了）：流已经关了，别再碰 controller。
      if (queue.isCancelled) return
      if (chunk === null) controller.close()
      else controller.enqueue(chunk)
    },
    cancel() {
      queue.cancel()
    }
  })
}
