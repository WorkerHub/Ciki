import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clampCropArea,
  cropAndNormalizeAvatar,
  encodeCanvasToWebPOrJpeg,
  isWebKitOrSafari,
  loadImageSource,
  resizeCropArea
} from "@/lib/avatar"

describe("avatar 归一化与裁剪运算", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("clampCropArea 选区边界约束", () => {
    it("选区最大为图片本身（min(width, height)），不能超过原图宽高", () => {
      const result = clampCropArea({ x: 0, y: 0, size: 1200 }, 800, 600)
      expect(result.size).toBe(600)
    })

    it("选区不许拖出图片边界（x/y 严格约束在 [0, image - size] 范围内）", () => {
      // x 超出右边界
      const clampedRight = clampCropArea({ x: 500, y: 0, size: 400 }, 800, 600)
      expect(clampedRight.x).toBe(400) // 800 - 400

      // y 超出下边界
      const clampedBottom = clampCropArea({ x: 0, y: 500, size: 300 }, 800, 600)
      expect(clampedBottom.y).toBe(300) // 600 - 300

      // x/y 小于 0
      const clampedNegative = clampCropArea(
        { x: -100, y: -50, size: 200 },
        800,
        600
      )
      expect(clampedNegative.x).toBe(0)
      expect(clampedNegative.y).toBe(0)
    })

    it("原图较小时，选区上限收缩为原图自身", () => {
      const result = clampCropArea({ x: 0, y: 0, size: 500 }, 300, 400)
      expect(result.size).toBe(300)
      expect(result.x).toBe(0)
      expect(result.y).toBe(0)
    })
  })

  describe("resizeCropArea 居中缩放", () => {
    it("以现有选区中心点为锚点进行缩放，并自动 clamp 至合法边界", () => {
      // 初始：在 (100, 100)，尺寸 200，中心在 (200, 200)
      // 缩小到 100：新位置应为 200 - 50 = 150
      const resized = resizeCropArea(
        { x: 100, y: 100, size: 200 },
        100,
        800,
        600
      )
      expect(resized.size).toBe(100)
      expect(resized.x).toBe(150)
      expect(resized.y).toBe(150)
    })

    it("放大导致超出边界时，平移回合法边界内", () => {
      const resized = resizeCropArea({ x: 10, y: 10, size: 100 }, 600, 800, 600)
      expect(resized.size).toBe(600)
      expect(resized.x).toBeGreaterThanOrEqual(0)
      expect(resized.x + resized.size).toBeLessThanOrEqual(800)
      expect(resized.y).toBe(0)
    })
  })

  describe("loadImageSource 解码与 EXIF 方向", () => {
    it("调用 createImageBitmap 时携带 imageOrientation: 'from-image' 校正 EXIF", async () => {
      const mockBitmap = {
        width: 1200,
        height: 800,
        close: vi.fn()
      } as unknown as ImageBitmap
      const spy = vi
        .spyOn(window, "createImageBitmap")
        .mockResolvedValueOnce(mockBitmap)

      const file = new File(["test-bytes"], "avatar.jpg", {
        type: "image/jpeg"
      })
      const res = await loadImageSource(file)

      expect(spy).toHaveBeenCalledWith(file, {
        imageOrientation: "from-image"
      })
      expect(res.width).toBe(1200)
      expect(res.height).toBe(800)
    })

    it("createImageBitmap 带参数异常时降级无参调用", async () => {
      const mockBitmap = {
        width: 1000,
        height: 1000,
        close: vi.fn()
      } as unknown as ImageBitmap
      const spy = vi
        .spyOn(window, "createImageBitmap")
        .mockRejectedValueOnce(new TypeError("Invalid option"))
        .mockResolvedValueOnce(mockBitmap)

      const file = new File(["bytes"], "avatar.png", { type: "image/png" })
      const res = await loadImageSource(file)

      expect(spy).toHaveBeenCalledTimes(2)
      expect(res.width).toBe(1000)
    })

    it("解码失败（零尺寸或完全无法解码）抛出 DECODE_FAILED，不许回退原图直传", async () => {
      vi.spyOn(window, "createImageBitmap").mockRejectedValue(
        new Error("Corrupt image data")
      )

      const file = new File(["invalid-bytes"], "corrupt.png", {
        type: "image/png"
      })
      await expect(loadImageSource(file)).rejects.toThrow("DECODE_FAILED")
    })

    it("在不支持 createImageBitmap 环境下降级 HTMLImageElement", async () => {
      const origCreateImageBitmap = window.createImageBitmap
      // @ts-expect-error remove createImageBitmap to test fallback
      delete window.createImageBitmap
      // @ts-expect-error remove from globalThis
      delete globalThis.createImageBitmap

      // Mock Image
      const origImage = globalThis.Image
      class MockImage {
        naturalWidth = 640
        naturalHeight = 480
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_val: string) {
          setTimeout(() => this.onload?.(), 10)
        }
      }
      // @ts-expect-error mock image
      globalThis.Image = MockImage

      try {
        const file = new File(["bytes"], "avatar.png", { type: "image/png" })
        const res = await loadImageSource(file)
        expect(res.width).toBe(640)
        expect(res.height).toBe(480)
      } finally {
        globalThis.Image = origImage
        window.createImageBitmap = origCreateImageBitmap
        globalThis.createImageBitmap = origCreateImageBitmap
      }
    })

    it("准确识别 Safari / iOS WebKit 环境", () => {
      const origNavigator = window.navigator
      const setUa = (ua: string, platform = "MacIntel", maxTouchPoints = 0) => {
        Object.defineProperty(window, "navigator", {
          value: { userAgent: ua, platform, maxTouchPoints },
          configurable: true
        })
      }

      try {
        // iPhone Safari
        setUa(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          "iPhone"
        )
        expect(isWebKitOrSafari()).toBe(true)

        // macOS Safari
        setUa(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
          "MacIntel",
          0
        )
        expect(isWebKitOrSafari()).toBe(true)

        // macOS Chrome
        setUa(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "MacIntel",
          0
        )
        expect(isWebKitOrSafari()).toBe(false)

        // Windows Firefox
        setUa(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
          "Win32",
          0
        )
        expect(isWebKitOrSafari()).toBe(false)
      } finally {
        Object.defineProperty(window, "navigator", {
          value: origNavigator,
          configurable: true
        })
      }
    })

    it("在 Safari / iOS WebKit 环境下绕过存在缺陷的 createImageBitmap，走 HTMLImageElement", async () => {
      const origNavigator = window.navigator
      Object.defineProperty(window, "navigator", {
        value: {
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
          platform: "iPhone",
          maxTouchPoints: 5
        },
        configurable: true
      })

      const origImage = globalThis.Image
      class MockSafariImage {
        naturalWidth = 3024
        naturalHeight = 4032
        onload: (() => void) | null = null
        set src(_val: string) {
          setTimeout(() => this.onload?.(), 10)
        }
      }
      // @ts-expect-error mock image
      globalThis.Image = MockSafariImage
      const bitmapSpy = vi.spyOn(window, "createImageBitmap")

      try {
        const file = new File(["bytes"], "iphone_portrait.jpg", {
          type: "image/jpeg"
        })
        const res = await loadImageSource(file)
        // Safari 下不调用有 bug 的 createImageBitmap(blob)
        expect(bitmapSpy).not.toHaveBeenCalled()
        expect(res.width).toBe(3024)
        expect(res.height).toBe(4032)
      } finally {
        globalThis.Image = origImage
        Object.defineProperty(window, "navigator", {
          value: origNavigator,
          configurable: true
        })
      }
    })
  })

  describe("cropAndNormalizeAvatar 与 编码逻辑", () => {
    it("原图大于 512 时，选区裁出后等比缩放到 512×512", async () => {
      const mockCanvas = document.createElement("canvas")
      mockCanvas.width = 1000
      mockCanvas.height = 1000

      const file = await cropAndNormalizeAvatar(
        mockCanvas,
        { x: 100, y: 100, size: 800 },
        "my-photo.jpg"
      )

      expect(file).toBeInstanceOf(File)
      expect(file.type).toBe("image/webp")
      expect(file.name).toBe("my-photo.webp")
    })

    it("原图小于 512 时不放大，按选区实际尺寸输出", async () => {
      let drawnWidth = 0
      let drawnHeight = 0
      const origGetContext = HTMLCanvasElement.prototype.getContext
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          const ctx = origGetContext.call(
            this,
            contextId,
            options
          ) as CanvasRenderingContext2D
          return {
            ...ctx,
            drawImage: (..._args: unknown[]) => {
              drawnWidth = this.width
              drawnHeight = this.height
            }
          } as unknown as CanvasRenderingContext2D
        }
      )

      const mockCanvas = document.createElement("canvas")
      mockCanvas.width = 300
      mockCanvas.height = 300

      const file = await cropAndNormalizeAvatar(
        mockCanvas,
        { x: 0, y: 0, size: 300 },
        "small.png"
      )

      expect(drawnWidth).toBe(300)
      expect(drawnHeight).toBe(300)
      expect(file.type).toBe("image/webp")
    })

    it("WebP 不支持时回退 JPEG 编码，文件类型和后缀变为 jpeg", async () => {
      // 模拟浏览器不支持 WebP 时 toBlob 返回 png（HTML 规范降级行为）
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
        (callback, type) => {
          if (type === "image/webp") {
            // 模拟不支持 webp，返回 png 类型 blob
            callback(new Blob(["png-data"], { type: "image/png" }))
          } else if (type === "image/jpeg") {
            callback(new Blob(["jpeg-data"], { type: "image/jpeg" }))
          }
        }
      )

      const canvas = document.createElement("canvas")
      canvas.width = 512
      canvas.height = 512

      const file = await encodeCanvasToWebPOrJpeg(canvas, "test.png")
      expect(file.type).toBe("image/jpeg")
      expect(file.name).toBe("test.jpeg")
    })

    it("编码完全失败时抛出异常，绝不回退原图直传", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
        (callback) => {
          callback(null)
        }
      )

      const canvas = document.createElement("canvas")
      await expect(
        encodeCanvasToWebPOrJpeg(canvas, "test.png")
      ).rejects.toThrow("ENCODING_FAILED")
    })
  })
})
