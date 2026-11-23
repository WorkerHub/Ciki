import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { SpacesAuthorizeDialog } from "@/components/SpacesAuthorizeDialog"
import {
  type AgentAccount,
  type AgentSpaceBatchResult,
  type AgentSpaceItem,
  type SpaceRole,
  meApi
} from "@/lib/api"

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

  const agentId = agent?.id
  const agentUsername = agent?.username
  const target = useMemo(
    () =>
      agentId !== undefined && agentUsername !== undefined
        ? { id: agentId, name: agentUsername }
        : null,
    [agentId, agentUsername]
  )

  const loadSpaces = useCallback(
    (id: number): Promise<AgentSpaceItem[]> => meApi.agents.spaces(id),
    []
  )
  const setSpaces = useCallback(
    (
      id: number,
      input: { spaceIds: number[]; role?: SpaceRole }
    ): Promise<AgentSpaceBatchResult> => meApi.agents.setSpaces(id, input),
    []
  )
  const removeSpace = useCallback(
    (id: number, spaceId: number): Promise<{ success: true }> =>
      meApi.agents.removeSpace(id, spaceId),
    []
  )

  if (!agent) return null

  return (
    <SpacesAuthorizeDialog
      open={open}
      onOpenChange={onOpenChange}
      target={target}
      title={t("settings.agents.spaces.title", { name: agent.username })}
      description={t("settings.agents.spaces.description")}
      emptyText={t("settings.agents.spaces.empty")}
      removeSuccessMessage={(name) =>
        t("settings.agents.spaces.removeSuccess", { name })
      }
      notEligibleErrorMessage={t("settings.agents.spaces.errors.notEligible")}
      loadSpaces={loadSpaces}
      setSpaces={setSpaces}
      removeSpace={removeSpace}
    />
  )
}
