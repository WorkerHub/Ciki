/**
 * 流式 zip 组装在 **workerd** 里的回归护栏（Node 侧用例见 `test/pages-download.test.ts`）。
 *
 * 为什么单开一份：规格 v1.0 §7 把「zip 流式组装的运行时表现」点名为 CI 覆盖不到的实机
 * 风险——fflate 的流式 `Zip` 依赖 ReadableStream 的背压与分块行为，Node 与 Workers 在
 * 这两件事上不是同一套实现。这里用与线上同一个运行时把它钉死：边读边吐、产出的包能被
 * 标准实现解开、条目字节原样进出。
 *
 * 用例自带上游字节流，不依赖 `test/support/*`（那套是 Node 专用的 D1/R2 替身）。
 */
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { zipStream } from "../../src/lib/zip-stream"

interface PullState {
  pulled: number
}

/** 上游替身：按块吐字节，并记录累计吐出的量（模拟 R2 的 object.body）。 */
function bodyOf(
  chunks: Uint8Array[],
  state: PullState
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      const chunk = chunks[index]
      state.pulled += chunk.byteLength
      controller.enqueue(chunk)
      index += 1
    }
  })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readAll(
  body: ReadableStream<Uint8Array>,
  onChunk?: (consumed: number) => void
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let consumed = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    consumed += value.byteLength
    onChunk?.(consumed)
  }
  return concat(chunks)
}

describe("流式 zip 组装（workerd）", () => {
  it("边读边吐：输出不等上游读完，积压有界", async () => {
    const imageChunks = Array.from({ length: 32 }, (_, index) =>
      new Uint8Array(64 * 1024).fill(index + 1)
    )
    const total = imageChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const state: PullState = { pulled: 0 }

    const body = zipStream(async (zip) => {
      await zip.addBinary("images/a.png", bodyOf(imageChunks, state))
      await zip.addText("页面.md", "# 页面\n\n正文")
    })

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let consumed = 0
    let backlog = 0

    const first = await reader.read()
    expect(first.done).toBe(false)
    // 第一块输出到手时上游远未读完。
    expect(state.pulled).toBeLessThan(total / 2)
    if (first.value) {
      chunks.push(first.value)
      consumed += first.value.byteLength
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      consumed += value.byteLength
      backlog = Math.max(backlog, state.pulled - consumed)
    }

    // 水位 1MiB + 一块：积压远小于 2MB 的包体，说明没把整包先攒在内存里。
    expect(backlog).toBeLessThan(1.5 * 1024 * 1024)

    const entries = unzipSync(concat(chunks))
    expect(Object.keys(entries).sort()).toEqual(["images/a.png", "页面.md"])
    expect(entries["images/a.png"]).toEqual(concat(imageChunks))
    expect(strFromU8(entries["页面.md"])).toBe("# 页面\n\n正文")
  }, 30_000)

  it("空条目不报错，UTF-8 文件名与压缩文本条目都正常", async () => {
    const body = zipStream(async (zip) => {
      await zip.addBinary("images/empty.png", bodyOf([], { pulled: 0 }))
      await zip.addText("空图页.md", "第一段\n\n第二段\n")
    })

    const entries = unzipSync(await readAll(body))
    expect(Object.keys(entries).sort()).toEqual([
      "images/empty.png",
      "空图页.md"
    ])
    expect(entries["images/empty.png"]).toEqual(new Uint8Array(0))
    expect(strFromU8(entries["空图页.md"])).toBe("第一段\n\n第二段\n")
  })

  it("消费端取消：上游也停（连接断开的路径）", async () => {
    let cancelled = false
    let pulls = 0
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(64 * 1024).fill(9))
      },
      cancel() {
        cancelled = true
      }
    })

    const body = zipStream(async (zip) => {
      await zip.addBinary("images/a.png", source)
    })

    const reader = body.getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()

    const deadline = Date.now() + 2000
    while (!cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(cancelled).toBe(true)
    // 取消之后不再无休止地拉上游。
    const pullsAtCancel = pulls
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pulls).toBe(pullsAtCancel)
  })

  it("多条二进制条目按顺序入包，字节原样", async () => {
    const state: PullState = { pulled: 0 }
    const named = Array.from({ length: 5 }, (_, index) => ({
      name: `images/${index}.png`,
      chunks: [new Uint8Array(1024).fill(index), new Uint8Array(512).fill(255)]
    }))

    const body = zipStream(async (zip) => {
      for (const entry of named) {
        await zip.addBinary(entry.name, bodyOf(entry.chunks, state))
      }
    })

    const entries = unzipSync(await readAll(body))
    expect(Object.keys(entries).sort()).toEqual(
      named.map((entry) => entry.name).sort()
    )
    for (const entry of named) {
      expect(entries[entry.name]).toEqual(concat(entry.chunks))
    }
  })
})
