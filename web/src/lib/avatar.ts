export interface DecodedImageSource {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

export interface CropArea {
  x: number
  y: number
  size: number
}

/**
 * 检查当前运行环境是否为 Safari 或 iOS WebKit。
 * WebKit 存在未修复 bug 237895（createImageBitmap from Blob 丢失 EXIF 方向），
 * 因此在 Safari / iOS 下必须改走 HTMLImageElement 以确保 EXIF 方向正确校正。
 */
export function isWebKitOrSafari(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  // iOS 设备（包含 iPadOS 桌面模式请求）
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  // macOS / iOS 上的 Safari（排除 Chrome/CriOS/Android/Edg 等）
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Android|Edg/i.test(ua)
  return isIOS || isSafari
}

/**
 * 通过 HTMLImageElement 解码图片（浏览器原生遵循 image-orientation: from-image）。
 */
export function loadViaImageElement(file: File): Promise<DecodedImageSource> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    let settled = false

    const handleSuccess = () => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        reject(new Error("DECODE_FAILED"))
        return
      }
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => {}
      })
    }

    const handleError = () => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      reject(new Error("DECODE_FAILED"))
    }

    img.onload = handleSuccess
    img.onerror = handleError
    img.src = url

    if (typeof img.decode === "function") {
      img
        .decode()
        .then(handleSuccess)
        .catch(() => {
          // img.decode 报错时由 onerror 接管
        })
    }
  })
}

/**
 * 使用平台原生能力解码图像并校正 EXIF 方向。
 * - Safari / iOS 下受 WebKit bug 237895 影响，createImageBitmap 会丢 EXIF，优先走 HTMLImageElement；
 * - 其它环境优先调用 createImageBitmap 带 imageOrientation: "from-image"；
 * - 若环境不支持配置字典则降级无参数 createImageBitmap；
 * - 若均不可用降级 HTMLImageElement；
 * - 解码失败（损坏、零宽高、格式不支持等）明确抛出 DECODE_FAILED 异常，禁止绕过归一化直传。
 * - GIF 天然提取首帧静态图像。
 */
export async function loadImageSource(file: File): Promise<DecodedImageSource> {
  if (isWebKitOrSafari()) {
    return loadViaImageElement(file)
  }

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image"
      })
      if (bitmap.width <= 0 || bitmap.height <= 0) {
        bitmap.close?.()
        throw new Error("DECODE_FAILED")
      }
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.()
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "DECODE_FAILED") {
        throw err
      }
      try {
        const bitmap = await createImageBitmap(file)
        if (bitmap.width <= 0 || bitmap.height <= 0) {
          bitmap.close?.()
          throw new Error("DECODE_FAILED")
        }
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close?.()
        }
      } catch {
        throw new Error("DECODE_FAILED")
      }
    }
  }

  return loadViaImageElement(file)
}

/**
 * 限制选区在图片边界内：
 * - 选区最大为图片本身（min(width, height)）；
 * - 选区不许拖出图片边界（0 <= x <= width - size, 0 <= y <= height - size）。
 */
export function clampCropArea(
  area: CropArea,
  imageWidth: number,
  imageHeight: number,
  minSize = 32
): CropArea {
  const maxSize = Math.max(1, Math.min(imageWidth, imageHeight))
  const actualMinSize = Math.min(minSize, maxSize)
  const size = Math.min(Math.max(area.size, actualMinSize), maxSize)
  const maxX = Math.max(0, imageWidth - size)
  const maxY = Math.max(0, imageHeight - size)
  const x = Math.min(Math.max(area.x, 0), maxX)
  const y = Math.min(Math.max(area.y, 0), maxY)
  return { x, y, size }
}

/**
 * 围绕选区中心缩放选区，并限制在边界内。
 */
export function resizeCropArea(
  current: CropArea,
  newSize: number,
  imageWidth: number,
  imageHeight: number,
  minSize = 32
): CropArea {
  const centerX = current.x + current.size / 2
  const centerY = current.y + current.size / 2
  const targetX = centerX - newSize / 2
  const targetY = centerY - newSize / 2
  return clampCropArea(
    { x: targetX, y: targetY, size: newSize },
    imageWidth,
    imageHeight,
    minSize
  )
}

/**
 * 将 Canvas 编码为 WebP（质量约 0.85）；若浏览器不支持 WebP 则回退 JPEG。
 * 编码失败直接报错，绝不回退原图直传。
 */
export async function encodeCanvasToWebPOrJpeg(
  canvas: HTMLCanvasElement,
  originalFileName = "avatar.png",
  quality = 0.85
): Promise<File> {
  const baseName = originalFileName.replace(/\.[^.]+$/, "") || "avatar"

  // 1. 优先尝试 WebP
  let blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", quality)
  })

  let finalType = "image/webp"
  let ext = "webp"

  // HTML 规范规定：若不支持请求的 mime 类型，toBlob 回退到 image/png。
  // 此时触发「WebP 不支持回退 JPEG」口径。
  if (blob?.type !== "image/webp") {
    blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality)
    })
    finalType = "image/jpeg"
    ext = "jpeg"
  }

  if (!blob) {
    throw new Error("ENCODING_FAILED")
  }

  const finalBlob =
    blob.type === finalType ? blob : new Blob([blob], { type: finalType })
  return new File([finalBlob], `${baseName}.${ext}`, { type: finalType })
}

/**
 * 按选区裁出并归一化头像：
 * - 原图/选区小于 512 不放大；
 * - 选区 >= 512 缩放到 512×512；
 * - 输出 WebP（不支持回退 JPEG）。
 */
export async function cropAndNormalizeAvatar(
  source: CanvasImageSource,
  crop: CropArea,
  originalFileName = "avatar.png",
  quality = 0.85
): Promise<File> {
  const targetSize = Math.max(1, Math.min(Math.round(crop.size), 512))
  const canvas = document.createElement("canvas")
  canvas.width = targetSize
  canvas.height = targetSize
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("CANVAS_UNAVAILABLE")
  }

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"

  ctx.drawImage(
    source,
    Math.round(crop.x),
    Math.round(crop.y),
    Math.round(crop.size),
    Math.round(crop.size),
    0,
    0,
    targetSize,
    targetSize
  )

  return encodeCanvasToWebPOrJpeg(canvas, originalFileName, quality)
}
