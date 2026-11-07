import { LogIn, ShieldCheck } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DatabaseTab } from "@/pages/admin/DatabaseTab"
import { SecurityTab } from "@/pages/admin/SecurityTab"
import { SettingsTab } from "@/pages/admin/SettingsTab"
import { UsersTab } from "@/pages/admin/UsersTab"

/** 系统管理：用户管理 / 应用设置 / 访问与安全 / 数据库维护（无 SMTP 分区）。 */
export function AdminPage() {
  const [tab, setTab] = useState("users")

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold tracking-tight">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          系统管理
        </h1>
        <p className="text-xs text-muted-foreground">
          站点级设置仅管理员可见。改动立即生效，不需要重启服务。
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="users">用户管理</TabsTrigger>
          <TabsTrigger value="site">应用设置</TabsTrigger>
          <TabsTrigger value="security">访问与安全</TabsTrigger>
          <TabsTrigger value="database">数据库维护</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-3">
          <UsersTab />
        </TabsContent>
        <TabsContent value="site" className="mt-3">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="security" className="mt-3">
          <SecurityTab />
        </TabsContent>
        <TabsContent value="database" className="mt-3">
          <DatabaseTab />
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LogIn
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            登录与注册
          </CardTitle>
          <CardDescription>
            登录支持账号密码 + 第二步验证（TOTP 或
            Passkey）；自助注册受上面的开关与审批控制。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/trash" className="text-xs underline underline-offset-4">
            去回收站查看已删除页面
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
