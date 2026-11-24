"use client"

import { ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import {
  clampCropArea,
  cropAndNormalizeAvatar,
  loadImageSource,
  resizeCropArea,
  type CropArea,
  type DecodedImageSource
} from "@/lib/avatar"

export interface AvatarCropDialogProps {
  open: boolean
  file: File | null
  onConfirm: (normalizedFile: File) => void
  onCancel: () => void
  onError: (errorText: string) => void
}

const MAX_PREVIEW_SIZE = 320
const MIN_CROP_SIZE = 32

export function AvatarCropDialog({
  open,
  file,
  onConfirm,
  onCancel,
  onError
}: AvatarCropDialogProps) {
  const { t } = useTranslation()
  const [decoded, setDecoded] = useState<DecodedImageSource | null>(null)
  const [cropArea, setCropArea] = useState<CropArea>({ x: 0, y: 0, size: 0 })
  const [isProcessing, setIsProcessing] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragStartRef = useRef<{
    pointerId: number
    clientX: number
    clientY: number
    cropX: number
    cropY: number
  } | null>(null)

  // 双指捏合手势跟踪
  const activePointersRef = useRef<
    Map<number, { clientX: number; clientY: number }>
  >(new Map())
  const pinchStartDistRef = useRef<number | null>(null)
  const pinchStartSizeRef = useRef<number | null>(null)

  // 文件传入时解码
  useEffect(() => {
    if (!open || !file) {
      setDecoded((prev) => {
        prev?.close?.()
        return null
      })
      setIsProcessing(false)
      return
    }

    let cancelled = false

    loadImageSource(file)
      .then((img) => {
        if (cancelled) {
          img.close?.()
          return
        }
        setDecoded(img)
        const initialSize = Math.min(img.width, img.height)
        setCropArea({
          x: Math.round((img.width - initialSize) / 2),
          y: Math.round((img.height - initialSize) / 2),
          size: initialSize
        })
      })
      .catch(() => {
        if (cancelled) return
        onError(t("profile.avatar.decodeFailed"))
        onCancel()
      })

    return () => {
      cancelled = true
    }
  }, [open, file, onError, onCancel, t])

  // 绘制预览 Canvas
  const width = decoded?.width ?? 0
  const height = decoded?.height ?? 0
  const scale =
    width > 0 && height > 0
      ? Math.min(MAX_PREVIEW_SIZE / width, MAX_PREVIEW_SIZE / height, 1)
      : 1
  const displayWidth = Math.max(1, Math.round(width * scale))
  const displayHeight = Math.max(1, Math.round(height * scale))

  useEffect(() => {
    if (!decoded || !canvasRef.current) return
    const canvas = canvasRef.current
    canvas.width = displayWidth
    canvas.height = displayHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(decoded.source, 0, 0, displayWidth, displayHeight)
  }, [decoded, displayWidth, displayHeight])

  const maxCropSize = Math.max(1, Math.min(width, height))
  const minCropSize = Math.min(MIN_CROP_SIZE, maxCropSize)

  const dispX = Math.round(cropArea.x * scale)
  const dispY = Math.round(cropArea.y * scale)
  const dispSize = Math.round(cropArea.size * scale)

  // 选区拖动事件
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStartRef.current = {
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      cropX: cropArea.x,
      cropY: cropArea.y
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      !dragStartRef.current ||
      dragStartRef.current.pointerId !== e.pointerId
    ) {
      return
    }
    const dx = (e.clientX - dragStartRef.current.clientX) / scale
    const dy = (e.clientY - dragStartRef.current.clientY) / scale
    setCropArea((prev) =>
      clampCropArea(
        {
          ...prev,
          x: dragStartRef.current!.cropX + dx,
          y: dragStartRef.current!.cropY + dy
        },
        width,
        height,
        minCropSize
      )
    )
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      dragStartRef.current &&
      dragStartRef.current.pointerId === e.pointerId
    ) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      dragStartRef.current = null
    }
  }

  // 容器双指捏合跟踪
  const handleContainerPointerDown = (
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    activePointersRef.current.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY
    })
    if (activePointersRef.current.size === 2) {
      const [p1, p2] = Array.from(activePointersRef.current.values())
      pinchStartDistRef.current = Math.hypot(
        p1.clientX - p2.clientX,
        p1.clientY - p2.clientY
      )
      pinchStartSizeRef.current = cropArea.size
    }
  }

  const handleContainerPointerMove = (
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY
      })
    }
    if (
      activePointersRef.current.size === 2 &&
      pinchStartDistRef.current &&
      pinchStartSizeRef.current
    ) {
      const [p1, p2] = Array.from(activePointersRef.current.values())
      const dist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY)
      if (dist > 0) {
        // 捏合缩小选区（即放大图像），张开放大选区
        const ratio = pinchStartDistRef.current / dist
        const targetSize = pinchStartSizeRef.current * ratio
        setCropArea((prev) =>
          resizeCropArea(prev, targetSize, width, height, minCropSize)
        )
      }
    }
  }

  const handleContainerPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId)
    if (activePointersRef.current.size < 2) {
      pinchStartDistRef.current = null
      pinchStartSizeRef.current = null
    }
  }

  // 桌面端滚轮缩放
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 0.95 : 1.05
    setCropArea((prev) =>
      resizeCropArea(prev, prev.size * factor, width, height, minCropSize)
    )
  }

  // 滑杆值计算：滑杆往右（值变大）代表放大视野（缩小选区 size）
  const sliderValue = maxCropSize + minCropSize - cropArea.size
  const handleSliderChange = ([val]: number[]) => {
    const targetSize = maxCropSize + minCropSize - val
    setCropArea((prev) =>
      resizeCropArea(prev, targetSize, width, height, minCropSize)
    )
  }

  const handleConfirm = async () => {
    if (!decoded || !file) return
    setIsProcessing(true)
    try {
      const normalized = await cropAndNormalizeAvatar(
        decoded.source,
        cropArea,
        file.name
      )
      decoded.close?.()
      onConfirm(normalized)
    } catch {
      onError(t("profile.avatar.decodeFailed"))
      onCancel()
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isProcessing) {
          onCancel()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("profile.avatar.cropTitle")}</DialogTitle>
        </DialogHeader>

        {decoded ? (
          <div className="space-y-4 py-2">
            <div
              className="relative mx-auto flex items-center justify-center overflow-hidden rounded-lg bg-black/5"
              style={{
                width: `${displayWidth}px`,
                height: `${displayHeight}px`
              }}
              onWheel={handleWheel}
              onPointerDown={handleContainerPointerDown}
              onPointerMove={handleContainerPointerMove}
              onPointerUp={handleContainerPointerEnd}
              onPointerCancel={handleContainerPointerEnd}
            >
              <canvas
                ref={canvasRef}
                width={displayWidth}
                height={displayHeight}
                className="block size-full"
              />

              {/* 蒙层与透出选区 */}
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full"
                viewBox={`0 0 ${displayWidth} ${displayHeight}`}
              >
                <path
                  fillRule="evenodd"
                  className="fill-black/60"
                  d={`M 0 0 H ${displayWidth} V ${displayHeight} H 0 Z M ${dispX} ${dispY} v ${dispSize} h ${dispSize} v -${dispSize} Z`}
                />
              </svg>

              {/* 可拖拽方形选区 */}
              <section
                data-testid="crop-box"
                aria-label={t("profile.avatar.cropTitle")}
                className="absolute cursor-move touch-none border-2 border-primary shadow-sm"
                style={{
                  left: `${dispX}px`,
                  top: `${dispY}px`,
                  width: `${dispSize}px`,
                  height: `${dispSize}px`
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {/* 头像圆形辅助参考线 */}
                <div className="pointer-events-none absolute inset-0 rounded-full border border-dashed border-white/60" />
                {/* 九宫格辅助参考线 */}
                <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 divide-x divide-y divide-white/20" />
              </section>
            </div>

            {/* 缩放滑杆 */}
            <div className="mx-auto flex max-w-xs items-center gap-2.5 px-2">
              <ZoomOut
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <Slider
                min={minCropSize}
                max={maxCropSize}
                step={1}
                value={[sliderValue]}
                onValueChange={handleSliderChange}
                aria-label={t("profile.avatar.zoomSlider")}
                disabled={isProcessing}
              />
              <ZoomIn
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            {t("profile.saving")}
          </div>
        )}

        <DialogFooter showCloseButton={false}>
          <Button
            type="button"
            variant="outline"
            disabled={isProcessing}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!decoded || isProcessing}
            onClick={() => void handleConfirm()}
          >
            {t("profile.avatar.cropConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
