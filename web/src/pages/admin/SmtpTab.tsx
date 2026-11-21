import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard"
import {
  adminApi,
  ApiError,
  describeApiError,
  type EmailProvider,
  type SiteSettings,
  type SmtpEncryption
} from "@/lib/api"
import { useAuthStore } from "@/stores/auth"

const PROVIDERS: EmailProvider[] = ["none", "smtp", "resend"]

/** SMTP 传输层三态（与后端 SMTP_ENCRYPTIONS 一致）。 */
const SMTP_ENCRYPTIONS: readonly SmtpEncryption[] = ["tls", "starttls", "none"]
/** 库里缺省或存了非法值时的回落值（与后端 readEmailSettings 默认一致）。 */
const DEFAULT_ENCRYPTION: SmtpEncryption = "starttls"

/** 后端保留非法值让管理员修，前端渲染时回落到默认，避免下拉框出现空态。 */
function normalizeEncryption(value: unknown): SmtpEncryption {
  return (SMTP_ENCRYPTIONS as readonly string[]).includes(value as string)
    ? (value as SmtpEncryption)
    : DEFAULT_ENCRYPTION
}

export function SmtpTab(props?: {
  settings?: SiteSettings
  onSaved?: (settings: SiteSettings) => void
}) {
  const { t } = useTranslation()
  const [internalSettings, setInternalSettings] = useState<SiteSettings | null>(
    null
  )
  const settings = props?.settings ?? internalSettings
  const onSaved = props?.onSaved ?? (() => {})

  const adminEmail = useAuthStore((state) => state.user?.email ?? "")

  const [provider, setProvider] = useState<EmailProvider>(
    settings?.email?.provider ?? "none"
  )
  const [smtp, setSmtp] = useState({
    host: settings?.email?.smtp.host ?? "",
    port: String(settings?.email?.smtp.port ?? ""),
    encryption: normalizeEncryption(settings?.email?.smtp.encryption),
    username: settings?.email?.smtp.username ?? "",
    from: settings?.email?.smtp.from ?? "",
    fromName: settings?.email?.smtp.fromName ?? ""
  })
  const [smtpPassword, setSmtpPassword] = useState("")
  const [resend, setResend] = useState({
    from: settings?.email?.resend.from ?? "",
    fromName: settings?.email?.resend.fromName ?? ""
  })
  const [resendKey, setResendKey] = useState("")

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const [testTo, setTestTo] = useState(adminEmail)
  const [userEditedTo, setUserEditedTo] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testError, setTestError] = useState("")

  useEffect(() => {
    if (adminEmail && !userEditedTo) {
      setTestTo(adminEmail)
    }
  }, [adminEmail, userEditedTo])

  useEffect(() => {
    if (props?.settings) return
    let alive = true
    adminApi
      .settings()
      .then((data) => {
        if (alive) setInternalSettings(data)
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeApiError(loadError))
      })
    return () => {
      alive = false
    }
  }, [props?.settings])

  useEffect(() => {
    if (!settings?.email) return
    setProvider(settings.email.provider)
    setSmtp({
      host: settings.email.smtp.host,
      port: String(settings.email.smtp.port ?? ""),
      encryption: normalizeEncryption(settings.email.smtp.encryption),
      username: settings.email.smtp.username,
      from: settings.email.smtp.from,
      fromName: settings.email.smtp.fromName
    })
    setResend({
      from: settings.email.resend.from,
      fromName: settings.email.resend.fromName
    })
  }, [settings])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await adminApi.updateSettings({
        email: {
          provider,
          smtp: { ...smtp, port: Number(smtp.port), password: smtpPassword },
          resend: { ...resend, apiKey: resendKey }
        }
      })
      setSmtpPassword("")
      setResendKey("")
      toast.success(t("admin.email.saved"))
      const fresh = await adminApi.settings()
      setInternalSettings(fresh)
      onSaved(fresh)
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async (event: React.FormEvent) => {
    event.preventDefault()
    setTestBusy(true)
    setTestError("")
    try {
      await adminApi.testEmail(testTo.trim())
      toast.success(t("admin.email.testSent"))
    } catch (sendError) {
      const detail =
        sendError instanceof ApiError && sendError.detail
          ? sendError.detail
          : describeApiError(sendError)
      setTestError(detail)
    } finally {
      setTestBusy(false)
    }
  }

  const message = (text: string) =>
    text ? (
      <p role="alert" className="text-sm text-destructive">
        {text}
      </p>
    ) : null

  if (!settings) {
    return error ? (
      <div className="rounded-xl border bg-card p-4">{message(error)}</div>
    ) : null
  }

  const isDirty = Boolean(
    settings.email &&
      (provider !== settings.email.provider ||
        smtp.host !== settings.email.smtp.host ||
        smtp.port !== String(settings.email.smtp.port ?? "") ||
        smtp.encryption !==
          normalizeEncryption(settings.email.smtp.encryption) ||
        smtp.username !== settings.email.smtp.username ||
        smtp.from !== settings.email.smtp.from ||
        smtp.fromName !== settings.email.smtp.fromName ||
        smtpPassword !== "" ||
        resend.from !== settings.email.resend.from ||
        resend.fromName !== settings.email.resend.fromName ||
        resendKey !== "")
  )

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <UnsavedChangesGuard isDirty={isDirty} />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-heading text-sm font-semibold">
          {t("admin.email.title")}
        </h3>
        <Badge variant={settings.email?.configured ? "secondary" : "outline"}>
          {settings.email?.configured
            ? t("common.emailConfigured")
            : t("common.emailNotConfigured")}
        </Badge>
      </div>

      <form className="space-y-4" onSubmit={save}>
        <div className="space-y-1.5">
          <Label htmlFor="email-provider">{t("admin.email.provider")}</Label>
          <Select
            value={provider}
            onValueChange={(value) => setProvider(value as EmailProvider)}
          >
            <SelectTrigger id="email-provider" className="w-full sm:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`admin.email.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {provider === "smtp" ? (
          <div className="space-y-3 border-t pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">{t("admin.email.host")}</Label>
                <Input
                  id="smtp-host"
                  value={smtp.host}
                  onChange={(event) =>
                    setSmtp({ ...smtp, host: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">{t("admin.email.port")}</Label>
                <Input
                  id="smtp-port"
                  inputMode="numeric"
                  value={smtp.port}
                  onChange={(event) =>
                    setSmtp({ ...smtp, port: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-encryption">
                  {t("admin.smtp.encryption.label")}
                </Label>
                <Select
                  value={smtp.encryption}
                  onValueChange={(value) =>
                    setSmtp({ ...smtp, encryption: value as SmtpEncryption })
                  }
                >
                  <SelectTrigger id="smtp-encryption" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SMTP_ENCRYPTIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`admin.smtp.encryption.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-username">
                  {t("admin.email.username")}
                </Label>
                <Input
                  id="smtp-username"
                  autoComplete="off"
                  value={smtp.username}
                  onChange={(event) =>
                    setSmtp({ ...smtp, username: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-password">
                  {t("admin.email.password")}
                </Label>
                <Input
                  id="smtp-password"
                  type="password"
                  autoComplete="new-password"
                  value={smtpPassword}
                  placeholder={
                    settings.email?.smtp.passwordSet
                      ? t("admin.email.secretSet")
                      : t("admin.email.secretEmpty")
                  }
                  onChange={(event) => setSmtpPassword(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from">{t("admin.email.from")}</Label>
                <Input
                  id="smtp-from"
                  type="email"
                  value={smtp.from}
                  onChange={(event) =>
                    setSmtp({ ...smtp, from: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from-name">
                  {t("admin.email.fromName")}
                </Label>
                <Input
                  id="smtp-from-name"
                  value={smtp.fromName}
                  onChange={(event) =>
                    setSmtp({ ...smtp, fromName: event.target.value })
                  }
                />
              </div>
            </div>
          </div>
        ) : null}

        {provider === "resend" ? (
          <div className="space-y-3 border-t pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="resend-key">{t("admin.email.apiKey")}</Label>
                <Input
                  id="resend-key"
                  type="password"
                  autoComplete="new-password"
                  value={resendKey}
                  placeholder={
                    settings.email?.resend.apiKeySet
                      ? t("admin.email.secretSet")
                      : t("admin.email.secretEmpty")
                  }
                  onChange={(event) => setResendKey(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resend-from">{t("admin.email.from")}</Label>
                <Input
                  id="resend-from"
                  type="email"
                  value={resend.from}
                  onChange={(event) =>
                    setResend({ ...resend, from: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="resend-from-name">
                  {t("admin.email.fromName")}
                </Label>
                <Input
                  id="resend-from-name"
                  value={resend.fromName}
                  onChange={(event) =>
                    setResend({ ...resend, fromName: event.target.value })
                  }
                />
              </div>
            </div>
          </div>
        ) : null}

        {message(error)}

        <Button type="submit" disabled={busy}>
          {busy ? t("common.actions.saving") : t("admin.email.save")}
        </Button>
      </form>

      <div className="space-y-3 border-t pt-4">
        <h4 className="text-sm font-medium">{t("admin.email.testTitle")}</h4>
        <form className="flex flex-wrap items-end gap-2" onSubmit={sendTest}>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="test-email-to">{t("admin.email.testTo")}</Label>
            <Input
              id="test-email-to"
              type="email"
              value={testTo}
              onChange={(event) => {
                setUserEditedTo(true)
                setTestTo(event.target.value)
              }}
            />
          </div>
          <Button type="submit" variant="outline" disabled={testBusy}>
            {testBusy ? t("common.loading") : t("admin.email.testSend")}
          </Button>
        </form>

        {testError ? (
          <div className="space-y-1">
            <p role="alert" className="text-sm text-destructive">
              {t("admin.email.testError")}
            </p>
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {testError}
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export { SmtpTab as EmailSection }
