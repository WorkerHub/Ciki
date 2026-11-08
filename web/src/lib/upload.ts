import { ApiError, api, meApi, type Me, type UploadedFile } from "@/lib/api"

/** 规格 §2.4：仅收图片，png/jpg/jpeg/gif/webp，单张上限 10MB。 */
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
] as const

export const ACCEPT_IMAGE_ATTR = ACCEPTED_IMAGE_TYPES.join(",")
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 返回给用户看的错误文案；通过校验返回 null。 */
export function validateImageFile(file: File): string | null {
  if (
    !ACCEPTED_IMAGE_TYPES.includes(
      file.type as (typeof ACCEPTED_IMAGE_TYPES)[number]
    )
  ) {
    return "只支持 PNG / JPG / GIF / WebP 图片（SVG 不收）"
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "图片超过 10MB，请压缩后再上传"
  }
  return null
}

export async function uploadImage(file: File): Promise<UploadedFile> {
  const invalid = validateImageFile(file)
  if (invalid) throw new ApiError(400, invalid, "INVALID_IMAGE")
  return api.upload(file)
}

/**
 * 头像专用上传口（规格 §1）：服务端落 avatars/ 并在同一请求里换掉本人头像、
 * 删旧图，所以返回的是更新后的完整资料（含新 avatarUrl），不再走
 * 「先上传拿 key、再 PUT /api/me/profile」两步。
 */
export async function uploadAvatar(file: File): Promise<Me> {
  const invalid = validateImageFile(file)
  if (invalid) throw new ApiError(400, invalid, "INVALID_IMAGE")
  return meApi.uploadAvatar(file)
}

/** 从剪贴板/拖拽事件里挑出图片文件。 */
export function imageFilesFrom(
  list: FileList | File[] | null | undefined
): File[] {
  if (!list) return []
  return Array.from(list).filter((file) =>
    ACCEPTED_IMAGE_TYPES.includes(
      file.type as (typeof ACCEPTED_IMAGE_TYPES)[number]
    )
  )
}
