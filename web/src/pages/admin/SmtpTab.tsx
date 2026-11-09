import { MailCheck, Send } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
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
const PASSWORD_MASK_HINT = "•••••••• 已保存，留空保持不变"

const EMPTY_FORM: SmtpForm = {
  host: "",
  port: "587",
  encryption: "starttls",
  username: "",
  from: "",
  fromName: ""
}

/** 三态的标签把端口习惯一并说清，省得用户去查邮件服务商文档。 */
const ENCRYPTION_OPTIONS: Array<{ value: SmtpEncryption; label: string }> = [
  { value: "tls", label: "TLS（465 端口，全程加密）" },
  { value: "starttls", label: "STARTTLS（587 端口，先连接再升级加密）" },
  { value: "none", label: "不加密（仅限内网自建服务）" }
]

function formFrom(config: SmtpSettings): SmtpForm {
  return {
    host: config.host ?? "",
    port: config.port ? String(config.port) : EMPTY_FORM.port,
    encryption: config.encryption ?? EMPTY_FORM.encryption,
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
    Promise.all([adminApi.smtp(), adminApi.settings()])
      .then(([config, settings]) => {
        if (!alive) return
        setForm(formFrom(config))
        setPasswordSet(config.passwordSet === true)
        setConfigured(settings.emailConfigured === true)
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
    if (!host) {
      setError("请填写 SMTP 服务器地址。")
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("端口需为 1–65535 的整数。")
      return
    }
    if (!from) {
      setError("请填写发件人地址。")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      setError("发件人地址格式不正确。")
      return
    }

    setSaving(true)
    try {
      await adminApi.saveSmtp({
        host,
        port,
        encryption: form.encryption,
        username: form.username.trim(),
        // 留空 = 保留原密文（契约语义），用户重录才提交新值
        password,
        from,
        fromName: form.fromName.trim()
      })
      // 回读一次：以服务端为准，顺便确认密码确实还在、状态标志真的翻了
      const [saved, settings] = await Promise.all([
        adminApi.smtp(),
        adminApi.settings()
      ])
      setForm(formFrom(saved))
      setPasswordSet(saved.passwordSet === true)
      setConfigured(settings.emailConfigured === true)
      setPassword("")
      // 站点级 emailConfigured（登录页、设置页的邮箱 2FA 入口都读它）跟着重拉，
      // 保存完就能立刻用，不必等用户刷新
      void useSiteStore.getState().load()
      setNotice(
        saved.passwordSet
          ? "SMTP 配置已保存。"
          : "SMTP 配置已保存（未设置密码）；服务商要求认证时请补填密码再保存。"
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
          ? `测试邮件已发送到 ${adminEmail}，请查收（也看一下垃圾箱）。`
          : "测试邮件已发送，请查收当前管理员邮箱。"
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
            SMTP 服务器
          </h3>
          <span
            className={
              configured
                ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300"
                : "rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300"
            }
          >
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {configured
            ? "邮箱验证码两步验证与找回密码都使用这份配置。"
            : "填好并保存后，邮箱验证码两步验证与找回密码才会启用。"}
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="服务器地址" htmlFor="smtp-host">
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
            label="端口"
            htmlFor="smtp-port"
            hint="TLS 常用 465，STARTTLS 常用 587。"
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

          <Field label="加密方式" htmlFor="smtp-encryption">
            <Select
              value={form.encryption}
              disabled={saving}
              onValueChange={(value) => update("encryption", value)}
            >
              <SelectTrigger
                id="smtp-encryption"
                aria-label="加密方式"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCRYPTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="用户名"
            htmlFor="smtp-username"
            hint="多数服务商要求填邮箱全称；留空表示匿名登录。"
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
            label="密码"
            htmlFor="smtp-password"
            hint={
              passwordSet
                ? "已保存密码，留空不会改动它；重录才会覆盖。"
                : "按服务商要求填写；有的服务商要用「授权码」而不是登录密码。"
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
              placeholder={passwordSet ? PASSWORD_MASK_HINT : "未设置"}
              disabled={saving}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <Field label="发件人地址" htmlFor="smtp-from">
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
            label="发件人名称"
            htmlFor="smtp-from-name"
            hint="收件人看到的显示名，留空只显示地址。"
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
            {saving ? "保存中…" : "保存配置"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testing || !configured}
            title={configured ? undefined : "先保存一份可用的配置"}
            onClick={() => void sendTest()}
          >
            <Send aria-hidden="true" />
            {testing ? "发送中…" : "发送测试邮件"}
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
          测试邮件只会发到当前管理员邮箱
          {adminEmail ? `（${adminEmail}）` : ""}
          ，用的是已保存的配置。
          {configured ? "" : "先保存配置，按钮才可用。"}
        </p>
      </form>
    </div>
  )
}
