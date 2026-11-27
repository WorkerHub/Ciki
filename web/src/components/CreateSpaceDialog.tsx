import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ApiError, describeApiError, type Space } from "@/lib/api"
import { isValidSpaceSlug, spaceSlugCandidate } from "@/lib/space"
import { useSpacesStore } from "@/stores/spaces"

export interface CreateSpaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: (space: Space) => void
}

/**
 * 新建空间共享对话框：
 * 侧栏空间切换器（SpaceSwitcher）与空间总览页（SpacesTab）共用。
 * 支持根据名称实时计算并填入候选 slug，支持手动指定并即时校验。
 * 创建成功后新空间入 store，成为当前空间，并导航至首页 `/`。
 */
export function CreateSpaceDialog({
  open,
  onOpenChange,
  onSuccess
}: CreateSpaceDialogProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const create = useSpacesStore((state) => state.create)

  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState("")
  const [slugError, setSlugError] = useState("")

  useEffect(() => {
    if (open) {
      setName("")
      setSlug("")
      setSlugEdited(false)
      setDescription("")
      setBusy(false)
      setCreateError("")
      setSlugError("")
    }
  }, [open])

  const handleNameChange = (value: string) => {
    setName(value)
    if (!slugEdited) {
      setSlug(spaceSlugCandidate(value))
      setSlugError("")
    }
  }

  const handleSlugChange = (value: string) => {
    setSlugEdited(true)
    setSlug(value)
    if (value !== "" && !isValidSpaceSlug(value)) {
      setSlugError(t("space.settings.info.slugFormat"))
    } else {
      setSlugError("")
    }
  }

  const submitCreate = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setCreateError(t("shell.spaces.create.nameRequired"))
      return
    }

    const trimmedSlug = slug.trim()
    if (slugEdited && trimmedSlug !== "") {
      if (!isValidSpaceSlug(trimmedSlug)) {
        setSlugError(t("space.settings.info.slugFormat"))
        return
      }
    }

    setBusy(true)
    setCreateError("")
    setSlugError("")

    const slugToSend =
      slugEdited && trimmedSlug !== "" ? trimmedSlug : undefined

    try {
      const space = await create(trimmedName, description.trim(), slugToSend)
      onOpenChange(false)
      onSuccess?.(space)
      navigate("/")
    } catch (submitError) {
      if (
        submitError instanceof ApiError &&
        (submitError.status === 409 || submitError.code === "SPACE_SLUG_TAKEN")
      ) {
        setSlugError(t("space.settings.info.slugConflict"))
      } else if (
        submitError instanceof ApiError &&
        submitError.code === "INVALID_SPACE_SLUG"
      ) {
        setSlugError(t("space.settings.info.slugFormat"))
      } else {
        setCreateError(describeApiError(submitError))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shell.spaces.new")}</DialogTitle>
          <DialogDescription>{t("shell.spaces.create.hint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submitCreate()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-space-name">
              {t("shell.spaces.create.name")}
            </Label>
            <Input
              id="new-space-name"
              name="space-name"
              autoFocus
              maxLength={64}
              value={name}
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder={t("shell.spaces.create.namePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-space-slug">
              {t("space.settings.info.slug")}
            </Label>
            <div className="relative">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-sm text-muted-foreground select-none"
              >
                /s/
              </span>
              <Input
                id="new-space-slug"
                name="space-slug"
                value={slug}
                onChange={(event) => handleSlugChange(event.target.value)}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className="pl-8 font-mono"
                aria-invalid={Boolean(slugError)}
              />
            </div>
            {slugError ? (
              <p role="alert" className="text-xs text-destructive">
                {slugError}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-space-description">
              {t("shell.spaces.create.description")}
            </Label>
            <Textarea
              id="new-space-description"
              name="space-description"
              maxLength={500}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("shell.spaces.create.descriptionPlaceholder")}
            />
          </div>
          {createError ? (
            <p role="alert" className="text-xs text-destructive">
              {createError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? t("shell.spaces.create.creating")
                : t("shell.spaces.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
