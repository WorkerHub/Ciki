import { ArrowLeft, KeyRound, Mail } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { AuthShell } from "@/components/AuthShell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, authApi, describeApiError } from "@/lib/api"
import { useSiteStore } from "@/stores/site"

/**
 * 邮箱找回密码（#48 冻结契约的前端部分，三步）：
 * 输账号邮箱 → 发码 → 验码换一次性 resetToken → 设新密码。
 *
 * 三条不能破坏的规矩：
 * - 第一步一律按同一句话展示结果，不从 200/文案推断邮箱是否存在（防枚举）；
 * - 第二步错码、过期、账号不存在都只显示同一句「验证码不正确或已过期」，
 *   连续输错 5 次按契约作废，提示重新获取；
 * - 第三步只拿 resetToken 说话，成功后后端已让该账号全部会话失效，
 *   这里不自动登录，明确引导回登录页。
 */
type Step = "email" | "code" | "password"

/** 等待秒数的说人话版本：一分钟以内报秒，更长报分钟（429 的 retryAfter 可能是小时窗）。 */
function formatWait(seconds: number): string {
  const value = Math.max(1, Math.round(seconds))
  if (value < 60) return `${value} 秒`
  return `${Math.ceil(value / 60)} 分钟`
}

/** 限流提示带上服务端给的真实剩余时间；其它错误照统一翻译。 */
function waitText(error: unknown): string {
  if (error instanceof ApiError && error.retryAfter) {
    return `操作过于频繁，请在 ${formatWait(error.retryAfter)}后重试。`
  }
  return describeApiError(error)
}

export function ForgotPasswordPage() {
  const emailConfigured = useSiteStore((state) => state.emailConfigured)
  const siteLoaded = useSiteStore((state) => state.loaded)
  const setEmailConfigured = useSiteStore((state) => state.setEmailConfigured)

  const [step, setStep] = useState<Step>("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)
  /** 站点是否配了发信：公开配置说 false 就整页换成「不可用」分支；
   *  提交时服务端回 503 也算权威结论（配置可能在打开页面之后被清掉）。 */
  const [emailUnavailable, setEmailUnavailable] = useState(false)
  /** 重发冷却（契约 60 秒，429 时按 retryAfter 起步）。 */
  const [cooldown, setCooldown] = useState(0)
  /** 验码被限流后的等待秒数：这段时间里提交按钮不装能点。 */
  const [verifyWait, setVerifyWait] = useState(0)
  /** 本页连续输错的次数；第 5 次按契约这枚码已作废。 */
  const [wrongCode, setWrongCode] = useState(0)

  const unavailable = emailUnavailable || (siteLoaded && !emailConfigured)
  const accountEmail = email.trim() || "账号邮箱"

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

  const sendCode = async (event?: React.FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError("")
    try {
      const sent = await authApi.passwordForgot(email.trim())
      // 响应与账号是否存在无关：只拿冷却秒数，文案保持「如果已注册」的中性说法
      setCooldown(sent.cooldownSeconds)
      setCode("")
      setWrongCode(0)
      setVerifyWait(0)
      setStep("code")
    } catch (sendError) {
      if (
        sendError instanceof ApiError &&
        sendError.code === "EMAIL_NOT_CONFIGURED"
      ) {
        setEmailUnavailable(true)
        setEmailConfigured(false)
        return
      }
      if (sendError instanceof ApiError && sendError.retryAfter) {
        setCooldown(sendError.retryAfter)
      }
      setError(waitText(sendError))
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const grant = await authApi.passwordVerify(email.trim(), code.trim())
      setResetToken(grant.resetToken)
      setCode("")
      setStep("password")
    } catch (verifyError) {
      if (
        verifyError instanceof ApiError &&
        verifyError.code === "RATE_LIMITED"
      ) {
        if (verifyError.retryAfter) setVerifyWait(verifyError.retryAfter)
        setError(waitText(verifyError))
        return
      }
      const failed = wrongCode + 1
      setWrongCode(failed)
      if (failed >= 5) {
        // 契约：第 5 次错误删除该码，只能重新发码
        setCode("")
        setError("验证码连续输错 5 次已作废，请重新发送验证码。")
        return
      }
      setError(describeApiError(verifyError))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")
    // 强度校验沿用注册 / 改密口径（至少 8 位），服务端同样会拦（WEAK_PASSWORD）
    if (newPassword.length < 8) {
      setError("新密码至少 8 位")
      return
    }
    if (newPassword !== repeat) {
      setError("两次输入的密码不一致")
      return
    }
    setBusy(true)
    try {
      await authApi.passwordReset(resetToken, newPassword)
      setNewPassword("")
      setRepeat("")
      setResetToken("")
      setDone(true)
    } catch (resetError) {
      // 设密端点也有 5 次 / 5 分钟的提交限流（#48 契约），同样带出剩余时间
      setError(waitText(resetError))
    } finally {
      setBusy(false)
    }
  }

  /** 回到第一步重新发码：邮箱保留，验证码与凭证一律清掉。 */
  const restart = () => {
    setStep("email")
    setCode("")
    setResetToken("")
    setWrongCode(0)
    setVerifyWait(0)
    setError("")
  }

  if (done) {
    return (
      <AuthShell title="密码已重置">
        <div className="space-y-3 text-sm">
          <p>新密码已生效。这个账号之前的所有登录状态都已失效。</p>
          <p className="text-muted-foreground">
            请用新密码重新登录；两步验证的配置不受影响。
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
      <AuthShell title="找回密码">
        <div className="space-y-3 text-sm">
          <p>站点还没有配置发信（SMTP），暂时无法通过邮件找回密码。</p>
          <p className="text-muted-foreground">
            {
              "请联系管理员在「系统管理 → 邮件配置」中填写 SMTP；管理员也可以直接为你重置密码。"
            }
          </p>
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to="/login">返回登录</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  if (step === "code") {
    return (
      <AuthShell
        title="输入验证码"
        subtitle={`如果 ${accountEmail} 已注册，验证码会在几分钟内送达，请同时检查垃圾邮件文件夹。`}
      >
        <form
          key="forgot-code-step"
          id="forgot-code-step"
          className="space-y-4"
          onSubmit={verifyCode}
        >
          <div className="space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="reset-code">邮箱验证码</Label>
              <Input
                id="reset-code"
                name="reset-code"
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
                10 分钟内有效，连续输错 5 次会作废
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || cooldown > 0}
                onClick={() => void sendCode()}
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
          <Button
            type="submit"
            size="sm"
            className="w-full"
            disabled={busy || verifyWait > 0 || code.length !== 6}
          >
            {busy ? "验证中…" : "验证"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={restart}
          >
            <ArrowLeft aria-hidden="true" />
            返回上一步
          </Button>
        </form>
      </AuthShell>
    )
  }

  if (step === "password") {
    return (
      <AuthShell
        title="设置新密码"
        subtitle="保存后这个账号的全部登录状态都会失效，需要用新密码重新登录。"
      >
        <form
          key="forgot-password-step"
          id="forgot-password-step"
          className="space-y-4"
          onSubmit={submitPassword}
        >
          <p className="text-xs text-muted-foreground">
            验证已通过，请在 10 分钟内完成设置；过期后需要重新收码。
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="reset-new-password">新密码（至少 8 位）</Label>
            <Input
              id="reset-new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-repeat-password">再次输入新密码</Label>
            <Input
              id="reset-repeat-password"
              name="repeat-password"
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" className="w-full" disabled={busy}>
            <KeyRound aria-hidden="true" />
            {busy ? "保存中…" : "保存新密码"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={restart}
          >
            重新获取验证码
          </Button>
        </form>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="找回密码"
      subtitle="用账号邮箱收一封验证码，验证通过后设置新密码。"
    >
      <form
        key="forgot-email-step"
        id="forgot-email-step"
        className="space-y-4"
        onSubmit={sendCode}
      >
        <div className="space-y-1.5">
          <Label htmlFor="reset-email">邮箱</Label>
          <Input
            id="reset-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          账号是否存在不会在页面上体现：如果这个邮箱已注册，会收到一封 6
          位验证码的邮件。
        </p>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" className="w-full" disabled={busy}>
          <Mail aria-hidden="true" />
          {busy ? "发送中…" : "发送验证码"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          想起密码了？
          <Link to="/login" className="underline underline-offset-4">
            返回登录
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}
