import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  CircleDotIcon,
  LayoutDashboardIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MoonIcon,
  ServerCogIcon,
  ServerCrashIcon,
  Settings2Icon,
  SunIcon,
  TerminalSquareIcon,
} from "lucide-react"

import { CodexSetup } from "@/components/codex-setup"
import { GatewaySettingsPanel } from "@/components/gateway-settings"
import { useLanguage, type Locale } from "@/components/language-provider"
import { ProviderManager } from "@/components/provider-manager"
import { useTheme } from "@/components/theme-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ProviderKeySection } from "@/features/provider-keys/provider-key-section"
import type { Health } from "@/gateway-types"
import { formatNumber } from "@/lib/format-number"

type ConnectionState = "connecting" | "live" | "offline" | "auth"

const translations = {
  en: {
    themeToLight: "Switch to light mode",
    themeToDark: "Switch to dark mode",
    languageToggle: "切换到中文",
    privateConsole: "PRIVATE CONSOLE",
    loginTitle: "Sign in to console",
    loginDescription: "Use your gateway token to continue.",
    tokenLabel: "Gateway token",
    tokenPlaceholder: "Enter token",
    login: "Sign in",
    invalidToken: "Incorrect token",
    cannotConnect: "Cannot connect to gateway",
    operations: "OPERATIONS / GATEWAY",
    title: "Codex Provider Gateway",
    subtitle: "Gateway v2 / Runtime telemetry",
    navigation: {
      dashboard: "Dashboard",
      providers: "Providers",
      settings: "Settings",
      codex: "Codex setup",
    },
    connection: {
      connecting: "CONNECTING",
      live: "LIVE MONITORING",
      offline: "OFFLINE",
      auth: "AUTH REQUIRED",
    },
    meta: {
      upstream: "upstream",
      port: "port",
      uptime: "uptime",
      gateway: "gateway",
      connecting: "Connecting to gateway…",
      unreachable: "Gateway unreachable",
      refreshed: "refreshed",
      setupRequired: "waiting for provider setup",
    },
    alertTitle: "Gateway unreachable",
    metricsLabel: "Gateway totals",
    metrics: {
      requests: "Requests",
      success: "Success",
      errors: "Errors",
      rateLimited: "Rate limited",
      tokens: "Tokens",
      lifetime: "LIFETIME",
      upstream: "UPSTREAM",
      total: "TOTAL",
      ok: "OK",
      fail: "FAIL",
      usage: "USAGE",
    },
    keyPool: "KEY POOL",
    connectionHealth: "Connection health",
    keysSynced: (count: number) =>
      `${count} ${count === 1 ? "key" : "keys"} · synced just now`,
    waitingForKeys: "Waiting for key data",
    providerSummary: (keys: number, requests: number) =>
      `${keys} ${keys === 1 ? "key" : "keys"} · ${requests} requests`,
    enabledProvider: "Enabled",
    disabledProvider: "Disabled",
    keyEnabled: "Enabled",
    keyDisabled: "Disabled",
    alwaysTry: "Always try",
    alwaysTryDescription:
      "Keep this key eligible after authentication or upstream failures",
    editWeight: "Edit weight",
    testKey: "Test key",
    refreshBalance: "Refresh balance",
    deleteKey: "Delete key",
    saveWeight: "Save weight",
    weightInvalid: "Weight must be greater than zero.",
    cancel: "Cancel",
    deleteKeyTitle: "Delete key?",
    deleteKeyDescription: (name: string) =>
      `The key ${name} will be removed from this provider immediately.`,
    actionFailed: "Key action failed",
    balanceRefreshed: "Balance refreshed",
    keyUpdated: "Key updated and applied",
    keyDeleted: "Key deleted",
    keyConnected: (status: number, latencyMs: number) =>
      `Connection succeeded · HTTP ${status} · ${latencyMs} ms`,
    lastEnabledKey: "At least one key must remain enabled",
    topUp: "Top-up",
    granted: "Granted",
    total: "Total",
    used: "Used",
    weight: "Weight",
    columns: {
      provider: "Provider",
      key: "Key",
      state: "State",
      balance: "Balance",
      inFlight: "In-flight",
      requests: "Requests",
      success: "Success",
      errors: "Errors",
      rateLimited: "429s",
      failures: "Failures",
      cooldown: "Cooldown",
      lastUsed: "Last used",
    },
    noKeys: "No keys configured",
    noKeysDescription:
      "Configure at least one gateway key to start routing requests.",
    unavailable: "unavailable",
    states: {
      healthy: "healthy",
      cooldown: "cooldown",
      invalid: "invalid",
      unhealthy: "failing",
      disabled: "disabled",
    },
    autoRefresh: "Auto-refresh every 2 seconds",
  },
  "zh-CN": {
    themeToLight: "切换到浅色模式",
    themeToDark: "切换到深色模式",
    languageToggle: "Switch to English",
    privateConsole: "私有控制台",
    loginTitle: "登录控制台",
    loginDescription: "使用 Gateway 令牌继续。",
    tokenLabel: "Gateway 令牌",
    tokenPlaceholder: "输入令牌",
    login: "登录",
    invalidToken: "令牌不正确",
    cannotConnect: "无法连接 Gateway",
    operations: "运维 / 网关",
    title: "Codex Provider Gateway",
    subtitle: "Gateway v2 / 运行遥测",
    navigation: {
      dashboard: "监控面板",
      providers: "Provider 管理",
      settings: "Gateway 设置",
      codex: "Codex 配置",
    },
    connection: {
      connecting: "正在连接",
      live: "实时监控",
      offline: "已离线",
      auth: "需要认证",
    },
    meta: {
      upstream: "上游",
      port: "端口",
      uptime: "运行时间",
      gateway: "网关",
      connecting: "正在连接 Gateway…",
      unreachable: "Gateway 无法连接",
      refreshed: "更新于",
      setupRequired: "等待 Provider 配置",
    },
    alertTitle: "Gateway 无法连接",
    metricsLabel: "网关统计",
    metrics: {
      requests: "请求总数",
      success: "成功请求",
      errors: "错误请求",
      rateLimited: "限流次数",
      tokens: "Token 用量",
      lifetime: "累计",
      upstream: "上游",
      total: "总计",
      ok: "正常",
      fail: "失败",
      usage: "用量",
    },
    keyPool: "密钥池",
    connectionHealth: "连接状态",
    keysSynced: (count: number) => `${count} 个密钥 · 刚刚同步`,
    waitingForKeys: "等待密钥数据",
    providerSummary: (keys: number, requests: number) =>
      `${keys} 个密钥 · ${requests} 次请求`,
    enabledProvider: "已启用",
    disabledProvider: "已停用",
    keyEnabled: "已启用",
    keyDisabled: "已停用",
    alwaysTry: "始终尝试",
    alwaysTryDescription: "鉴权或上游失败后，后续请求仍可继续使用此密钥",
    editWeight: "编辑权重",
    testKey: "测试密钥",
    refreshBalance: "刷新额度",
    deleteKey: "删除密钥",
    saveWeight: "保存权重",
    weightInvalid: "权重必须大于 0。",
    cancel: "取消",
    deleteKeyTitle: "删除密钥？",
    deleteKeyDescription: (name: string) =>
      `密钥 ${name} 将立即从当前 Provider 中移除。`,
    actionFailed: "密钥操作失败",
    balanceRefreshed: "额度已刷新",
    keyUpdated: "密钥已更新并生效",
    keyDeleted: "密钥已删除",
    keyConnected: (status: number, latencyMs: number) =>
      `连接成功 · HTTP ${status} · ${latencyMs} 毫秒`,
    lastEnabledKey: "至少需要保留一个已启用密钥",
    topUp: "充值",
    granted: "赠送",
    total: "总额度",
    used: "已使用",
    weight: "权重",
    columns: {
      provider: "Provider",
      key: "密钥",
      state: "状态",
      balance: "余额",
      inFlight: "处理中",
      requests: "请求数",
      success: "成功数",
      errors: "错误数",
      rateLimited: "429 次数",
      failures: "连续失败",
      cooldown: "冷却时间",
      lastUsed: "最后使用",
    },
    noKeys: "尚未配置密钥",
    noKeysDescription: "至少配置一个 Gateway 密钥后才能开始转发请求。",
    unavailable: "不可用",
    states: {
      healthy: "健康",
      cooldown: "冷却中",
      invalid: "无效",
      unhealthy: "异常但继续尝试",
      disabled: "已停用",
    },
    autoRefresh: "每 2 秒自动刷新",
  },
} as const

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const { locale } = useLanguage()
  const t = translations[locale]
  const isDark = theme === "dark"
  const label = isDark ? t.themeToLight : t.themeToDark

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="outline" size="icon" aria-label={label} />}
        onClick={() => setTheme(isDark ? "light" : "dark")}
      >
        {isDark ? (
          <SunIcon data-icon="inline-start" />
        ) : (
          <MoonIcon data-icon="inline-start" />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function LanguageToggle() {
  const { locale, setLocale } = useLanguage()
  const label = translations[locale].languageToggle

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="outline" size="icon" aria-label={label} />}
        onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
      >
        <LanguagesIcon data-icon="inline-start" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function BrandMark() {
  return (
    <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <ActivityIcon aria-hidden="true" />
    </div>
  )
}

function ConnectionBadge({
  state,
  locale,
}: {
  state: ConnectionState
  locale: Locale
}) {
  const labels = translations[locale].connection
  const content = {
    connecting: { label: labels.connecting, variant: "outline" as const },
    live: { label: labels.live, variant: "secondary" as const },
    offline: { label: labels.offline, variant: "destructive" as const },
    auth: { label: labels.auth, variant: "outline" as const },
  }[state]

  return (
    <Badge variant={content.variant}>
      <CircleDotIcon data-icon="inline-start" />
      {content.label}
    </Badge>
  )
}

function MetricCard({
  label,
  value,
  note,
  badge,
  loading,
  locale,
}: {
  label: string
  value: number
  note: string
  badge: string
  loading: boolean
  locale: Locale
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{note}</CardDescription>
        <CardAction>
          <Badge variant="outline">{badge}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatNumber(value, locale)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function LoadingKeyCards() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <Card key={index} size="sm" className="min-h-72">
            <CardHeader>
              <CardTitle>
                <Skeleton className="h-4 w-28" />
              </CardTitle>
              <CardAction>
                <Skeleton className="h-5 w-16" />
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Skeleton className="h-16 w-40" />
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 6 }, (_, metric) => (
                  <Skeleton key={metric} className="h-9 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

function LoginView() {
  const { locale } = useLanguage()
  const t = translations[locale]
  const [token, setToken] = useState("")
  const [error, setError] = useState<"" | "invalidToken" | "cannotConnect">("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError("")

    try {
      const response = await fetch("/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) {
        setError("invalidToken")
        return
      }
      window.location.assign("/")
    } catch {
      setError("cannotConnect")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-3">
          <BrandMark />
          <span className="font-mono text-xs text-muted-foreground">
            DEEPSEEK GATEWAY
          </span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardDescription>{t.privateConsole}</CardDescription>
            <CardTitle>{t.loginTitle}</CardTitle>
            <CardDescription>{t.loginDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="gateway-token">
                    {t.tokenLabel}
                  </FieldLabel>
                  <Input
                    id="gateway-token"
                    type="password"
                    value={token}
                    placeholder={t.tokenPlaceholder}
                    autoFocus
                    autoComplete="current-password"
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  {error && <FieldError>{t[error]}</FieldError>}
                </Field>
              </FieldGroup>
              <Button type="submit" disabled={submitting}>
                {submitting && <Spinner data-icon="inline-start" />}
                {t.login}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function Dashboard({
  health,
  connection,
  loading,
  error,
  onRefresh,
}: {
  health: Health | null
  connection: ConnectionState
  loading: boolean
  error: string
  onRefresh: () => Promise<void>
}) {
  const { locale } = useLanguage()
  const t = translations[locale]
  const totals = health?.total ?? {
    requests: 0,
    success: 0,
    errors: 0,
    ratelimited: 0,
    tokens: 0,
  }
  const refreshedAt = new Date().toLocaleTimeString(locale)
  const providers = health?.setupRequired
    ? []
    : health
      ? health.providers?.length
        ? health.providers
        : [
            {
              id: health.defaultProvider,
              name: health.defaultProvider,
              baseUrl: health.upstream || "",
              upstreamFormat: "responses" as const,
              enabled: true,
              balanceQueryEnabled: false,
              modelCount: 0,
              total: health.total,
              keys: health.keys,
            },
          ]
      : []
  const keyCount = providers.reduce(
    (count, provider) => count + provider.keys.length,
    0
  )

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-stretch gap-6 px-6 py-8 sm:flex-row sm:items-start sm:justify-between lg:px-8">
          <div className="flex items-start gap-4">
            <BrandMark />
            <div className="flex flex-col gap-1">
              <p className="font-mono text-xs font-semibold text-primary">
                {t.operations}
              </p>
              <h1 className="text-3xl font-semibold sm:text-4xl">{t.title}</h1>
              <p className="text-sm text-muted-foreground">{t.subtitle}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <LanguageToggle />
            <ThemeToggle />
            <ConnectionBadge state={connection} locale={locale} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
          <span>
            {health
              ? health.setupRequired
                ? `${t.meta.setupRequired} · ${t.meta.port} ${health.port} · ${t.meta.gateway} v${health.version}`
                : `${t.meta.upstream} ${health.upstream} · ${t.meta.port} ${health.port} · ${t.meta.uptime} ${health.uptime}s · ${t.meta.gateway} v${health.version}`
              : connection === "connecting"
                ? t.meta.connecting
                : t.meta.unreachable}
          </span>
          <span>{health ? `${t.meta.refreshed} ${refreshedAt}` : ""}</span>
        </div>

        {error && (
          <Alert variant="destructive">
            <ServerCrashIcon />
            <AlertTitle>{t.alertTitle}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {health?.setupRequired ? (
          <ProviderManager locale={locale} setupMode onConfigured={onRefresh} />
        ) : (
          <Tabs defaultValue="dashboard" className="flex flex-col gap-5">
            <TabsList
              variant="line"
              className="w-full justify-start overflow-x-auto"
            >
              <TabsTrigger
                value="dashboard"
                aria-label={t.navigation.dashboard}
                title={t.navigation.dashboard}
              >
                <LayoutDashboardIcon data-icon="inline-start" />
                <span className="hidden sm:inline">
                  {t.navigation.dashboard}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="providers"
                aria-label={t.navigation.providers}
                title={t.navigation.providers}
              >
                <ServerCogIcon data-icon="inline-start" />
                <span className="hidden sm:inline">
                  {t.navigation.providers}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="settings"
                aria-label={t.navigation.settings}
                title={t.navigation.settings}
              >
                <Settings2Icon data-icon="inline-start" />
                <span className="hidden sm:inline">
                  {t.navigation.settings}
                </span>
              </TabsTrigger>
              <TabsTrigger
                value="codex"
                aria-label={t.navigation.codex}
                title={t.navigation.codex}
              >
                <TerminalSquareIcon data-icon="inline-start" />
                <span className="hidden sm:inline">{t.navigation.codex}</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dashboard" className="flex flex-col gap-8 pt-2">
              <section
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
                aria-label={t.metricsLabel}
              >
                <MetricCard
                  label={t.metrics.requests}
                  value={totals.requests}
                  note={t.metrics.lifetime}
                  badge={t.metrics.total}
                  loading={loading}
                  locale={locale}
                />
                <MetricCard
                  label={t.metrics.success}
                  value={totals.success}
                  note={t.metrics.lifetime}
                  badge={t.metrics.ok}
                  loading={loading}
                  locale={locale}
                />
                <MetricCard
                  label={t.metrics.errors}
                  value={totals.errors}
                  note={t.metrics.lifetime}
                  badge={t.metrics.fail}
                  loading={loading}
                  locale={locale}
                />
                <MetricCard
                  label={t.metrics.rateLimited}
                  value={totals.ratelimited}
                  note={t.metrics.upstream}
                  badge="HTTP 429"
                  loading={loading}
                  locale={locale}
                />
                <MetricCard
                  label={t.metrics.tokens}
                  value={totals.tokens}
                  note={t.metrics.lifetime}
                  badge={t.metrics.usage}
                  loading={loading}
                  locale={locale}
                />
              </section>

              <section className="flex flex-col gap-6" aria-label={t.keyPool}>
                <header className="flex flex-wrap items-end justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {t.keyPool}
                    </p>
                    <h2 className="text-xl font-semibold">
                      {t.connectionHealth}
                    </h2>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {health ? t.keysSynced(keyCount) : t.waitingForKeys}
                  </p>
                </header>

                {loading && !health ? <LoadingKeyCards /> : null}
                {!loading && keyCount === 0 ? (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <KeyRoundIcon />
                      </EmptyMedia>
                      <EmptyTitle>{t.noKeys}</EmptyTitle>
                      <EmptyDescription>{t.noKeysDescription}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {providers.map((provider) => (
                  <ProviderKeySection
                    key={provider.id}
                    provider={provider}
                    locale={locale}
                    copy={t}
                    onRefresh={onRefresh}
                  />
                ))}
              </section>

              <footer className="flex justify-between gap-4 font-mono text-xs text-muted-foreground">
                <span>{t.autoRefresh}</span>
                <span>Codex Provider Gateway</span>
              </footer>
            </TabsContent>
            <TabsContent value="providers" className="pt-2">
              <ProviderManager locale={locale} />
            </TabsContent>
            <TabsContent value="settings" className="pt-2">
              <GatewaySettingsPanel locale={locale} />
            </TabsContent>
            <TabsContent value="codex" className="pt-2">
              <CodexSetup locale={locale} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </main>
  )
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/health", {
        headers: { accept: "application/json" },
      })
      if (response.status === 401) {
        setConnection("auth")
        setLoading(false)
        return
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const nextHealth = (await response.json()) as Health
      setHealth(nextHealth)
      setConnection("live")
      setError("")
      setLoading(false)
    } catch (cause) {
      setConnection("offline")
      setLoading(false)
      setError(cause instanceof Error ? cause.message : "Unknown error")
    }
  }, [])

  useEffect(() => {
    const initialRefresh = window.setTimeout(refresh, 0)
    const timer = window.setInterval(refresh, 2000)
    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(timer)
    }
  }, [refresh])

  if (connection === "auth") {
    return <LoginView />
  }

  return (
    <Dashboard
      health={health}
      connection={connection}
      loading={loading}
      error={error}
      onRefresh={refresh}
    />
  )
}

export default App
