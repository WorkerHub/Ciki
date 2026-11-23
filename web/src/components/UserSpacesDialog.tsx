import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { SpacesAuthorizeDialog } from "@/components/SpacesAuthorizeDialog"
import {
  type AdminUser,
  type AgentSpaceBatchResult,
  type AgentSpaceItem,
  type SpaceRole,
  adminApi
} from "@/lib/api"

export interface UserSpacesDialogProps {
  user: AdminUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UserSpacesDialog({
  user,
  open,
  onOpenChange
}: UserSpacesDialogProps) {
  const { t } = useTranslation()

  const userId = user?.id
  const userEmail = user?.email
  const target = useMemo(
    () =>
      userId !== undefined && userEmail !== undefined
        ? { id: userId, name: userEmail }
        : null,
    [userId, userEmail]
  )

  const loadSpaces = useCallback(
    (id: number): Promise<AgentSpaceItem[]> => adminApi.userSpaces(id),
    []
  )
  const setSpaces = useCallback(
    (
      id: number,
      input: { spaceIds: number[]; role?: SpaceRole }
    ): Promise<AgentSpaceBatchResult> => adminApi.setUserSpaces(id, input),
    []
  )
  const removeSpace = useCallback(
    (id: number, spaceId: number): Promise<{ success: true }> =>
      adminApi.removeUserSpace(id, spaceId),
    []
  )

  if (!user) return null

  const displayName = user.email

  return (
    <SpacesAuthorizeDialog
      open={open}
      onOpenChange={onOpenChange}
      target={target}
      title={t("admin.users.spaces.title", { name: displayName })}
      description={t("admin.users.spaces.description")}
      emptyText={t("admin.users.spaces.empty")}
      removeSuccessMessage={(name) =>
        t("admin.users.spaces.removeSuccess", { name })
      }
      notEligibleErrorMessage={t("admin.users.spaces.errors.notEligible")}
      loadSpaces={loadSpaces}
      setSpaces={setSpaces}
      removeSpace={removeSpace}
    />
  )
}
