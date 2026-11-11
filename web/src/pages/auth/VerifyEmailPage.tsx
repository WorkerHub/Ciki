import { CircleCheck, Mail } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, authApi, describeApiError } from "@/lib/api"
import { waitText } from "@/lib/auth-wait"
import {
  RESEND_COOLDOWN_SECONDS,
  VERIFY_CODE_TTL_MINUTES,
  verifyEmailEntry
} from "@/lib/email-verification"
import { useSiteStore } from "@/stores/site"

/** 输入框下方的一行反馈：成功是中性说明，失败才用 alert 语气。 */
interface Note {
  tone: "info" | "error"
  text: string
}

/**
 * 注册邮箱验证页（#85 冻结契约的前端部分）。
 *
 * 未登录可访问：验证只认「邮箱 + 验证码」，不要求会话；成功后只置已验证、
 * 不发放会话，因此这里不自动登录，只引导回登录页。
 *
 * 两条不能破坏的规矩：
 * - 错码、过期、已用过、未知邮箱只显示同一句「验证码不正确或已过期。」，
 *   不从文案透出账号是否存在；
 * - 重发一律 200（账号存在与否同形），页面只看冷却秒数，不据此宣布「已发送到」以外的事。
 */
export function VerifyEmailPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const entry = verifyEmailEntry(location.state, searchParams.get("email"))
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)

  const [email, setEmail] = useState(entry.email)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [note, setNote] = useState<Note | null>(null)
  const [done, setDone] = useState(false)
  /** 站点没配发信时整页换成不可用分支：没有 SMTP 就收不到验证码。 */
  const [emailUnavailable, setEmailUnavailable] = useState(false)
  /** 重发冷却：注册成功后进页时服务端已发过一封，先按合约的 60 秒锁住。 */
  const [cooldown, setCooldown] = useState(
    entry.codeSent ? RESEND_COOLDOWN_SECONDS : 0
  )
  /** 验码被限流后的等待秒数：这段时间里提交按钮不装能点。 */
  const [verifyWait, setVerifyWait] = useState(0)

  const unavailable = emailUnavailable || (siteLoaded && !emailConfigured)
  const target = email.trim()

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(
      () => setCooldown((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [cooldown])

  useEffect(() => {
    if (verifyWait <= 0) return
    const timer = setTimeout(
      () => setVerifyWait((left) => Math.max(0, left - 1)),
      1000
    )
    return () => clearTimeout(timer)
  }, [verifyWait])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!target) {
      setError("请先填写要验证的邮箱。")
      return
    }
    setBusy(true)
    setError("")
    try {
      await authApi.verifyEmail(target, code.trim())
      setCode("")
      setDone(true)
    } catch (verifyError) {
      if (
        verifyError instanceof ApiError &&
        verifyError.code === "RATE_LIMITED"
      ) {
        if (verifyError.retryAfter) setVerifyWait(verifyError.retryAfter)
        setError(waitText(verifyError))
        return
      }
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    setBusy(true)
    setError("")
    setNote(null)
    try {
      const sent = await authApi.resendVerificationEmail(target)
      setCooldown(sent.cooldownSeconds || RESEND_COOLDOWN_SECONDS)
      // 新码换掉旧码：把已输入的旧码清掉，免得反复拿它去试
      setCode("")
      setNote({
        tone: "info",
        text: `验证码已发送到 ${target}，${VERIFY_CODE_TTL_MINUTES} 分钟内有效。`
      })
    } catch (sendError) {
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setCooldown(sendError.retryAfter)
      }
      if (
        sendError instanceof ApiError &&
        sendError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailUnavailable(true)
        setEmailConfigured(false)
        return
      }
      setNote({ tone: "error", text: waitText(sendError) })
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthShell title="邮箱已验证">
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-1.5">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500"
              aria-hidden="true"
            />
            <span>
              {entry.approvalRequired
                ? `${target} 已验证通过。账号还在等待管理员批准，批准后就能用这个邮箱登录。`
                : `${target} 已验证通过，现在可以用它登录了。`}
            </span>
          </p>
          <Button asChild size="sm" className="w-full">
            <Link to="/login">去登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (unavailable) {
    return (
      <AuthShell title="验证邮箱">
        <div className="space-y-3 text-sm">
          <p>站点还没有配置发信（SMTP），暂时无法通过邮件验证邮箱。</p>
          <p className="text-muted-foreground">
            {
              "请联系管理员在「系统管理 → 邮件配置」中填写 SMTP，配置好后重新发送验证码即可。"
            }
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">返回登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="验证邮箱"
      subtitle={
        target
          ? `输入发到 ${target} 的 6 位验证码，验证后才能登录。`
          : "输入注册邮箱与邮件里的 6 位验证码，验证后才能登录。"
      }
    >
      <form
        key="verify-email-step"
        id="verify-email-step"
        className="space-y-4"
        onSubmit={submit}
      >
        <div className="space-y-1.5">
          <Label htmlFor="verify-email">邮箱</Label>
          <Input
            id="verify-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="verify-code">邮箱验证码</Label>
            <Input
              id="verify-code"
              name="verify-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              required
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="123456"
              className="w-36 text-center font-mono text-lg tracking-[0.4em]"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Mail className="size-3.5" aria-hidden="true" />
              {VERIFY_CODE_TTL_MINUTES} 分钟内有效
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy || cooldown > 0 || !target}
              onClick={() => void resend()}
            >
              {cooldown > 0 ? `${cooldown}s 后可重发` : "重新发送验证码"}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {note ? (
          <p
            role={note.tone === "error" ? "alert" : "status"}
            className={
              note.tone === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {note.text}
          </p>
        ) : null}

        <Button
          type="submit"
          size="sm"
          className="w-full"
          disabled={busy || verifyWait > 0 || code.length !== 6}
        >
          {busy ? "验证中…" : "验证"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          已经验证过了？
          <Link to="/login" className="underline underline-offset-4">
            去登录
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
