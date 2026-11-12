import { ShieldCheck } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DatabaseTab } from "@/pages/admin/DatabaseTab"
import { SecurityTab } from "@/pages/admin/SecurityTab"
import { SettingsTab } from "@/pages/admin/SettingsTab"
import { SmtpTab } from "@/pages/admin/SmtpTab"
import { SpacesTab } from "@/pages/admin/SpacesTab"
import { UsersTab } from "@/pages/admin/UsersTab"

/**
 * 系统管理：用户管理 / 空间总览 / 应用设置 / 访问与安全 / 邮件配置 / 数据库维护。
 * SMTP 配置在「邮件配置」里，邮箱验证码 2FA 与找回密码都靠它发信。
 */
export function AdminPage() {
  const [tab, setTab] = useState("users")
  const { t } = useTranslation()

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("admin.title")}
        </h1>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="users">{t("admin.tabs.users")}</TabsTrigger>
          <TabsTrigger value="spaces">{t("admin.tabs.spaces")}</TabsTrigger>
          <TabsTrigger value="site">{t("admin.tabs.settings")}</TabsTrigger>
          <TabsTrigger value="security">{t("admin.tabs.security")}</TabsTrigger>
          <TabsTrigger value="email">{t("admin.tabs.email")}</TabsTrigger>
          <TabsTrigger value="database">{t("admin.tabs.database")}</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-3">
          <UsersTab />
        </TabsContent>
        <TabsContent value="spaces" className="mt-3">
          <SpacesTab />
        </TabsContent>
        <TabsContent value="site" className="mt-3">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="security" className="mt-3">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="email" className="mt-3">
          <SmtpTab />
        </TabsContent>
        <TabsContent value="database" className="mt-3">
          <DatabaseTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
