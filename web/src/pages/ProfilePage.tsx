import { UserRound } from "lucide-react"
import { cn } from "cn"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AvatarCropDialog } from "@/components/AvatarCropDialog"
import { displayUsername, UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { describeApiError, meApi } from "@/lib/api"
import {
  ACCEPT_IMAGE_ATTR,
  uploadAvatar,
  validateImageFile
} from "@/lib/upload"
import { useAuthStore } from "@/stores/auth"

/**
 * 个人资料：可改用户名与头像（头像走专用上传口 POST /api/me/avatar，上传即
 * 换掉本人头像并由服务端删旧图），用户 ID 与邮箱只读。
 * 用户名默认展示态，点修改进入编辑态。
 * 头像在点「保存」时才上传：选图阶段只做本地预览，没选文件时不出现保存按钮。
 */
export function ProfilePage() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const { t } = useTranslation()
  const [isEditingUsername, setIsEditingUsername] = useState(false)
  const [username, setUsername] = useState(user ? displayUsername(user) : "")
  const [savingUsername, setSavingUsername] = useState(false)
  const [isEditingBio, setIsEditingBio] = useState(false)
  const [bio, setBio] = useState(user?.bio ?? "")
  const [savingBio, setSavingBio] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [cropOpen, setCropOpen] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!isEditingBio && user) {
      setBio(user.bio ?? "")
    }
  }, [user, isEditingBio])

  if (!user) return null

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null
    // 允许再次选择同一个文件（否则 input 的 value 不变不会再触发 change）
    event.target.value = ""
    if (!next) return
    const invalid = validateImageFile(next)
    if (invalid) {
      setFile(null)
      setError(invalid)
      return
    }
    setError("")
    setNotice("")
    setCropFile(next)
    setCropOpen(true)
  }

  const handleCropConfirm = (normalizedFile: File) => {
    setCropOpen(false)
    setCropFile(null)
    setFile(normalizedFile)
  }

  const handleCropCancel = () => {
    setCropOpen(false)
    setCropFile(null)
  }

  const handleCropError = (msg: string) => {
    setCropOpen(false)
    setCropFile(null)
    setError(msg)
  }

  const startEditUsername = () => {
    setUsername(displayUsername(user))
    setError("")
    setIsEditingUsername(true)
  }

  const cancelEditUsername = () => {
    setUsername(displayUsername(user))
    setError("")
    setIsEditingUsername(false)
  }

  const startEditBio = () => {
    setBio(user.bio ?? "")
    setError("")
    setIsEditingBio(true)
  }

  const cancelEditBio = () => {
    setBio(user.bio ?? "")
    setError("")
    setIsEditingBio(false)
  }

  const saveBio = async () => {
    const trimmed = bio.trim()
    if (Array.from(trimmed).length > 100) {
      setError(t("profile.bio.overLimit"))
      return
    }
    setSavingBio(true)
    setError("")
    setNotice("")
    try {
      const updated = await meApi.updateProfile({ bio: trimmed })
      setUser(updated)
      setBio(updated.bio ?? "")
      setIsEditingBio(false)
      setNotice(t("profile.saved"))
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSavingBio(false)
    }
  }

  const saveUsername = async () => {
    const trimmed = username.trim()
    if (!trimmed) {
      setError(t("profile.emptyUsername"))
      return
    }
    setSavingUsername(true)
    setError("")
    setNotice("")
    try {
      const updated = await meApi.updateProfile({ username: trimmed })
      setUser(updated)
      setUsername(displayUsername(updated))
      setIsEditingUsername(false)
      setNotice(t("profile.saved"))
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSavingUsername(false)
    }
  }

  const saveAvatar = async () => {
    if (!file) return
    setSavingAvatar(true)
    setError("")
    setNotice("")
    try {
      const updated = await uploadAvatar(file)
      setUser(updated)
      setFile(null)
      setNotice(t("profile.saved"))
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSavingAvatar(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <UserRound
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("profile.title")}
        </h1>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("profile.avatar.title")}
            </CardTitle>
            <CardDescription>{t("profile.avatar.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <UserAvatar
              user={{ ...user, avatarUrl: preview ?? user.avatarUrl }}
              className="size-16 text-lg"
            />
            <div className="space-y-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={savingAvatar}
                onClick={() => fileInput.current?.click()}
              >
                {t("profile.avatar.change")}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT_IMAGE_ATTR}
                aria-label={t("profile.avatar.select")}
                className="sr-only"
                onChange={pickFile}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("profile.info.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label
                htmlFor={isEditingUsername ? "profile-username" : undefined}
              >
                {t("profile.info.username")}
              </Label>
              {isEditingUsername ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveUsername()
                  }}
                >
                  <Input
                    id="profile-username"
                    name="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="nickname"
                    autoFocus
                    disabled={savingUsername}
                    className="max-w-xs"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        cancelEditUsername()
                      }
                    }}
                  />
                  <Button type="submit" size="sm" disabled={savingUsername}>
                    {savingUsername ? t("profile.saving") : t("common.save")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={savingUsername}
                    onClick={cancelEditUsername}
                  >
                    {t("common.cancel")}
                  </Button>
                </form>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">
                    {displayUsername(user)}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={startEditUsername}
                  >
                    {t("profile.info.edit")}
                  </Button>
                </div>
              )}
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-[6rem_1fr] sm:gap-3">
              <dt className="text-xs font-medium text-muted-foreground">
                {t("profile.info.email")}
              </dt>
              <dd className="break-all">{user.email}</dd>
            </dl>
          </CardContent>
        </Card>

        {/* /profile 仅人类会话可达——后端登录口（auth.ts:375 密码、:649 Passkey）已挡 agent，agent 无资料编辑入口 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("profile.bio.title")}
            </CardTitle>
            <CardDescription>{t("profile.bio.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isEditingBio ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveBio()
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="profile-bio">{t("profile.bio.label")}</Label>
                  <Textarea
                    id="profile-bio"
                    name="bio"
                    value={bio}
                    onChange={(event) => setBio(event.target.value)}
                    placeholder={t("profile.bio.placeholder")}
                    rows={3}
                    autoFocus
                    disabled={savingBio}
                    aria-invalid={Array.from(bio.trim()).length > 100}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        cancelEditBio()
                      } else if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault()
                        void saveBio()
                      }
                    }}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {Array.from(bio.trim()).length > 100 ? (
                      <span className="text-destructive font-medium">
                        {t("profile.bio.overLimit")}
                      </span>
                    ) : (
                      <span />
                    )}
                    <span
                      className={cn(
                        "tabular-nums",
                        Array.from(bio.trim()).length > 100 &&
                          "text-destructive font-medium"
                      )}
                    >
                      {Array.from(bio.trim()).length}/100
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={savingBio || Array.from(bio.trim()).length > 100}
                  >
                    {savingBio ? t("profile.saving") : t("common.save")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={savingBio}
                    onClick={cancelEditBio}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <p className="text-sm text-foreground whitespace-pre-wrap break-words flex-1">
                  {user.bio ? (
                    user.bio
                  ) : (
                    <span className="text-muted-foreground">
                      {t("profile.bio.empty")}
                    </span>
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={startEditBio}
                  className="shrink-0 self-start"
                  aria-label={t("profile.bio.edit")}
                >
                  {t("profile.bio.edit")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {file ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={savingAvatar}
              onClick={() => void saveAvatar()}
            >
              {savingAvatar ? t("profile.saving") : t("common.save")}
            </Button>
          </div>
        ) : null}
      </div>

      <AvatarCropDialog
        open={cropOpen}
        file={cropFile}
        onConfirm={handleCropConfirm}
        onCancel={handleCropCancel}
        onError={handleCropError}
      />
    </div>
  )
}
