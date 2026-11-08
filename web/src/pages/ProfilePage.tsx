import { UserRound } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { displayUsername, UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { describeApiError, meApi } from "@/lib/api"
import { ACCEPT_IMAGE_ATTR, uploadImage, validateImageFile } from "@/lib/upload"
import { useAuthStore } from "@/stores/auth"

/**
 * 个人资料：可改用户名与头像（走现有 R2 上传通道），用户 ID 与邮箱只读。
 * 头像在点「保存」时才上传，避免选了文件又离开时在 R2 留下孤儿对象。
 */
export function ProfilePage() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const [username, setUsername] = useState(user ? displayUsername(user) : "")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
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

  if (!user) return null

  const shownName = displayUsername(user)
  const nameChanged = username.trim() !== (user.username ?? "")
  const canSave = !saving && (nameChanged || file !== null)

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
    setFile(next)
  }

  const save = async () => {
    const trimmed = username.trim()
    if (!trimmed) {
      setError("用户名不能为空。")
      return
    }
    if (!canSave) return
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const avatarKey = file ? (await uploadImage(file)).key : undefined
      const updated = await meApi.updateProfile({
        ...(nameChanged ? { username: trimmed } : {}),
        ...(avatarKey ? { avatarKey } : {})
      })
      setUser(updated)
      setUsername(displayUsername(updated))
      setFile(null)
      setNotice("个人资料已保存。")
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
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
          个人资料
        </h1>
        <p className="text-xs text-muted-foreground">
          头像与用户名会显示在顶栏和头像菜单里；用户 ID 与邮箱只读。
        </p>
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

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">头像</CardTitle>
            <CardDescription>
              PNG / JPG / GIF / WebP，单张不超过 10MB；保存后生效。
            </CardDescription>
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
                disabled={saving}
                onClick={() => fileInput.current?.click()}
              >
                更换头像
              </Button>
              <p className="text-[11px] text-muted-foreground">
                没有头像时显示用户名首字母。
              </p>
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT_IMAGE_ATTR}
                aria-label="选择头像"
                className="sr-only"
                onChange={pickFile}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">显示信息</CardTitle>
            <CardDescription>用户名可改，不要求唯一。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-username">用户名</Label>
              <Input
                id="profile-username"
                name="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="nickname"
              />
              <p className="text-[11px] text-muted-foreground">
                顶栏与头像菜单会显示这个名字（现在显示「{shownName}」）。
              </p>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-[6rem_1fr] sm:gap-3">
              <dt className="text-xs font-medium text-muted-foreground">
                用户 ID
              </dt>
              <dd className="font-mono text-xs break-all">
                {user.publicId || user.id}
              </dd>
              <dt className="text-xs font-medium text-muted-foreground">
                邮箱
              </dt>
              <dd className="break-all">{user.email}</dd>
            </dl>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </div>
  )
}
