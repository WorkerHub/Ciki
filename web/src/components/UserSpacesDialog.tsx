import { useTranslation } from "react-i18next"
import { SpacesAuthorizeDialog } from "@/components/SpacesAuthorizeDialog"
import { type AdminUser, adminApi } from "@/lib/api"

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

  if (!user) return null

  const displayName = user.email

  return (
    <SpacesAuthorizeDialog
      open={open}
      onOpenChange={onOpenChange}
      target={{ id: user.id, name: displayName }}
      title={t("admin.users.spaces.title", { name: displayName })}
      description={t("admin.users.spaces.description")}
      emptyText={t("admin.users.spaces.empty")}
      removeSuccessMessage={(name) =>
        t("admin.users.spaces.removeSuccess", { name })
      }
      notEligibleErrorMessage={t("admin.users.spaces.errors.notEligible")}
      loadSpaces={(id) => adminApi.userSpaces(id)}
      setSpaces={(id, input) => adminApi.setUserSpaces(id, input)}
      removeSpace={(id, spaceId) => adminApi.removeUserSpace(id, spaceId)}
    />
  )
}
