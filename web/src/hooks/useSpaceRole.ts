import type { SpaceRole } from "@/lib/api"
import { roleForSpace } from "@/lib/space"
import { useAuthStore } from "@/stores/auth"
import { useSpacesStore } from "@/stores/spaces"

/**
 * 指定空间里「我」的有效角色；空间不在可见列表、列表还没到时返回 null。
 * 写入口只在 canEdit/canManage 为真时渲染，所以 null 天然是只读。
 */
export function useSpaceRole(
  spaceId: string | null | undefined
): SpaceRole | null {
  const spaces = useSpacesStore((state) => state.spaces)
  const isSiteAdmin = useAuthStore((state) => state.user?.role === "admin")
  return roleForSpace(spaces, spaceId, isSiteAdmin)
}
