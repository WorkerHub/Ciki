import { useTranslation } from "react-i18next"
import { SpacesAuthorizeDialog } from "@/components/SpacesAuthorizeDialog"
import { type AgentAccount, meApi } from "@/lib/api"

export interface AgentSpacesDialogProps {
  agent: AgentAccount | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AgentSpacesDialog({
  agent,
  open,
  onOpenChange
}: AgentSpacesDialogProps) {
  const { t } = useTranslation()

  if (!agent) return null

  return (
    <SpacesAuthorizeDialog
      open={open}
      onOpenChange={onOpenChange}
      target={{ id: agent.id, name: agent.username }}
      title={t("settings.agents.spaces.title", { name: agent.username })}
      description={t("settings.agents.spaces.description")}
      emptyText={t("settings.agents.spaces.empty")}
      removeSuccessMessage={(name) =>
        t("settings.agents.spaces.removeSuccess", { name })
      }
      notEligibleErrorMessage={t("settings.agents.spaces.errors.notEligible")}
      loadSpaces={(id) => meApi.agents.spaces(id)}
      setSpaces={(id, input) => meApi.agents.setSpaces(id, input)}
      removeSpace={(id, spaceId) => meApi.agents.removeSpace(id, spaceId)}
    />
  )
}
