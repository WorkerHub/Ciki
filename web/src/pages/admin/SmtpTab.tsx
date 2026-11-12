import { MailCheck, Send } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
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
import {
  adminApi,
  describeApiError,
  type SmtpEncryption,
  type SmtpSettings
} from "@/lib/api"
import { useAuthStore } from "@/stores/auth"
import { useSiteStore } from "@/stores/site"

/** 表单里的端口用字符串，方便用户边输边改；提交前才收成数字。 */
interface SmtpForm {
  host: string
  port: string
  encryption: SmtpEncryption
  username: string
  from: string
  fromName: string
}

/** 已存密码时只以掩码示人，绝不回显明文。 */
const PASSWORD_MASK_HINT_KEY = "admin.smtp.password.maskHint"

const EMPTY_FORM: SmtpForm = {
  host: "",
  port: "587",
  encryption: "starttls",
  username: "",
  from: "",
  fromName: ""
}

/** 三态的标签把端口习惯一并说清，省得用户去查邮件服务商文档。 */
const ENCRYPTION_OPTIONS: Array<{ value: SmtpEncryption; labelKey: string }> = [
  { value: "tls", labelKey: "admin.smtp.encryption.tls" },
  { value: "starttls", labelKey: "admin.smtp.encryption.starttls" },
  { value: "none", labelKey: "admin.smtp.encryption.none" }
]

function formFrom(config: SmtpSettings | null): SmtpForm {
  if (!config) return { ...EMPTY_FORM }
  // 库里的 encryption 可能停在旧值（服务端保留原样让管理员修），不合法就回落到默认
  const encryption = ENCRYPTION_OPTIONS.some(
    (option) => option.value === config.encryption
  )
    ? config.encryption
    : EMPTY_FORM.encryption
  return {
    host: config.host ?? "",
    port: config.port ? String(config.port) : EMPTY_FORM.port,
    encryption,
    username: config.username ?? "",
    from: config.from ?? "",
    fromName: config.fromName ?? ""
  }
}

function Field({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string
  hint?: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * 系统管理 → 邮件配置：SMTP 服务器、发件人，以及「发一封测试邮件」。
 * 契约：GET 只回 passwordSet，密码框永远不吃回显，留空即保留原密文。
 */
export function SmtpTab() {
  const adminEmail = useAuthStore((state) => state.user?.email ?? "")
  const { t } = useTranslation()
  const [form, setForm] = useState<SmtpForm | null>(null)
  const [password, setPassword] = useState("")
  const [passwordSet, setPasswordSet] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [testError, setTestError] = useState("")
  const [testNotice, setTestNotice] = useState("")

  useEffect(() => {
    let alive = true
    adminApi
      .smtp()
      .then((state) => {
        if (!alive) return
        setForm(formFrom(state.config))
        setPasswordSet(state.config?.passwordSet === true)
        setConfigured(state.emailConfigured === true)
      })
      .catch((loadError: unknown) => {
        if (alive) setError(describeApiError(loadError))
      })
    return () => {
      alive = false
    }
  }, [])

  const update = (field: keyof SmtpForm, value: string) => {
    setForm((current) => (current ? { ...current, [field]: value } : current))
  }

  const save = async () => {
    if (!form) return
    setError("")
    setNotice("")
    setTestError("")
    setTestNotice("")

    const host = form.host.trim()
    const port = Number(form.port)
    const from = form.from.trim()
    const username = form.username.trim()
    // 服务端规则：用户名与密码必须同时有或同时空（保留原密文也算「有」）
    const hasPassword = password !== "" || passwordSet
    if (!host) {
      setError(t("admin.smtp.errors.host"))
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t("admin.smtp.errors.port"))
      return
    }
    if (!from) {
      setError(t("admin.smtp.errors.from"))
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      setError(t("admin.smtp.errors.fromFormat"))
      return
    }
    if (hasPassword && !username) {
      setError(t("admin.smtp.errors.usernameRequired"))
      return
    }
    if (!hasPassword && username) {
      setError(t("admin.smtp.errors.passwordRequired"))
      return
    }

    setSaving(true)
    try {
      const result = await adminApi.saveSmtp({
        host,
        port,
        encryption: form.encryption,
        username,
        // 留空 = 保留原密文（契约语义），用户重录才提交新值
        password,
        from,
        fromName: form.fromName.trim()
      })
      // 回读一次：以服务端为准（PUT 不回 passwordSet），顺便确认非密字段真的落了库
      const state = await adminApi.smtp()
      setForm(formFrom(state.config))
      setPasswordSet(state.config?.passwordSet === true)
      setConfigured(state.emailConfigured === true)
      setPassword("")
      // 站点级 emailConfigured（登录页、设置页的邮箱 2FA 入口都读它）跟着重拉，
      // 保存完就能立刻用，不必等用户刷新
      void useSiteStore.getState().load()
      setNotice(
        result.emailConfigured
          ? t("admin.smtp.notices.saved")
          : t("admin.smtp.notices.savedIncomplete")
      )
    } catch (saveError) {
      setError(describeApiError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    setTestError("")
    setTestNotice("")
    try {
      await adminApi.testSmtp()
      setTestNotice(
        adminEmail
          ? t("admin.smtp.notices.testSent", { email: adminEmail })
          : t("admin.smtp.notices.testSentUnknown")
      )
    } catch (failure) {
      setTestError(describeApiError(failure))
    } finally {
      setTesting(false)
    }
  }

  if (!form) {
    return (
      <div className="space-y-2">
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : (
          [0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-lg bg-muted/60"
            />
          ))
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <form
        className="max-w-3xl rounded-xl border border-border p-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <MailCheck
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("admin.smtp.title")}
          </h3>
          <span
            className={
              configured
                ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300"
                : "rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
            }
          >
            {configured
              ? t("admin.smtp.configured")
              : t("admin.smtp.unconfigured")}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {configured
            ? t("admin.smtp.hintConfigured")
            : t("admin.smtp.hintUnconfigured")}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={t("admin.smtp.host.label")} htmlFor="smtp-host">
            <Input
              id="smtp-host"
              name="smtp-host"
              value={form.host}
              placeholder="smtp.example.com"
              autoComplete="off"
              disabled={saving}
              onChange={(event) => update("host", event.target.value)}
            />
          </Field>

          <Field
            label={t("admin.smtp.port.label")}
            htmlFor="smtp-port"
            hint={t("admin.smtp.port.hint")}
          >
            <Input
              id="smtp-port"
              name="smtp-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port}
              disabled={saving}
              onChange={(event) => update("port", event.target.value)}
            />
          </Field>

          <Field
            label={t("admin.smtp.encryption.label")}
            htmlFor="smtp-encryption"
          >
            <Select
              value={form.encryption}
              disabled={saving}
              onValueChange={(value) => update("encryption", value)}
            >
              <SelectTrigger
                id="smtp-encryption"
                aria-label={t("admin.smtp.encryption.label")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCRYPTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label={t("admin.smtp.username.label")}
            htmlFor="smtp-username"
            hint={t("admin.smtp.username.hint")}
          >
            <Input
              id="smtp-username"
              name="smtp-username"
              value={form.username}
              autoComplete="off"
              disabled={saving}
              onChange={(event) => update("username", event.target.value)}
            />
          </Field>

          <Field
            label={t("admin.smtp.password.label")}
            htmlFor="smtp-password"
            hint={
              passwordSet
                ? t("admin.smtp.password.hintSaved")
                : t("admin.smtp.password.hintEmpty")
            }
          >
            <Input
              id="smtp-password"
              name="smtp-password"
              type="password"
              // 别让浏览器把管理员的登录密码自动填进 SMTP 密码框
              autoComplete="new-password"
              value={password}
              // 掩码用占位符表达：输入框里永远是空值，重录才会覆盖（GET 从不回密码）
              placeholder={
                passwordSet
                  ? t(PASSWORD_MASK_HINT_KEY)
                  : t("admin.smtp.password.unset")
              }
              disabled={saving}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <Field label={t("admin.smtp.from.label")} htmlFor="smtp-from">
            <Input
              id="smtp-from"
              name="smtp-from"
              type="email"
              value={form.from}
              placeholder="no-reply@example.com"
              autoComplete="off"
              disabled={saving}
              onChange={(event) => update("from", event.target.value)}
            />
          </Field>

          <Field
            label={t("admin.smtp.fromName.label")}
            htmlFor="smtp-from-name"
            hint={t("admin.smtp.fromName.hint")}
          >
            <Input
              id="smtp-from-name"
              name="smtp-from-name"
              value={form.fromName}
              placeholder="Ciki"
              autoComplete="off"
              disabled={saving}
              onChange={(event) => update("fromName", event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? t("admin.common.saving") : t("admin.smtp.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || !configured}
            title={configured ? undefined : t("admin.smtp.testDisabled")}
            onClick={() => void sendTest()}
          >
            <Send aria-hidden="true" />
            {testing ? t("admin.smtp.testing") : t("admin.smtp.test")}
          </Button>
        </div>

        {/* 保存与发测试的反馈就放在按钮下方：手机上不用滚回页顶找结果 */}
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}
        {testError ? (
          <p
            role="alert"
            className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {testError}
          </p>
        ) : null}
        {testNotice ? (
          <p
            role="status"
            className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
          >
            {testNotice}
          </p>
        ) : null}

        <p className="mt-3 text-[11px] text-muted-foreground">
          {t("admin.smtp.testNote", {
            email: adminEmail
              ? t("admin.smtp.testNoteEmail", { email: adminEmail })
              : ""
          })}
          {configured ? "" : t("admin.smtp.testNoteDisabled")}
        </p>
      </form>
    </div>
  )
}
