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
  SunIcon,
  TerminalSquareIcon,
} from "lucide-react"

import { CodexSetup } from "@/components/codex-setup"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import type { GatewayKey, Health } from "@/gateway-types"

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
    },
    autoRefresh: "每 2 秒自动刷新",
  },
} as const

const numberFormatters: Record<Locale, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US"),
  "zh-CN": new Intl.NumberFormat("zh-CN"),
}

function formatNumber(value: number, locale: Locale) {
  return numberFormatters[locale].format(value)
}

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

function StatusBadge({
  keyInfo,
  locale,
}: {
  keyInfo: GatewayKey
  locale: Locale
}) {
  const translatedState =
    translations[locale].states[
      keyInfo.state as keyof (typeof translations)["en"]["states"]
    ] ?? keyInfo.state
  const variant =
    keyInfo.state === "invalid"
      ? "destructive"
      : keyInfo.state === "healthy"
        ? "secondary"
        : "outline"

  return (
    <Badge variant={variant}>
      <CircleDotIcon data-icon="inline-start" />
      {translatedState}
    </Badge>
  )
}

function BalanceCell({
  keyInfo,
  locale,
}: {
  keyInfo: GatewayKey
  locale: Locale
}) {
  const infos = keyInfo.balance?.infos ?? []

  if (!infos.length) {
    return <TableCell className="text-muted-foreground">—</TableCell>
  }

  return (
    <TableCell>
      <div className="flex flex-col gap-1 font-mono text-xs">
        {infos.map((info) => (
          <span key={`${keyInfo.name}-${info.currency}`}>
            <span className="text-muted-foreground">{info.currency}</span>{" "}
            {info.totalBalance}
          </span>
        ))}
        {!keyInfo.balance?.isAvailable && (
          <span className="text-destructive">
            {translations[locale].unavailable}
          </span>
        )}
      </div>
    </TableCell>
  )
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 3 }, (_, index) => (
        <TableRow key={`loading-${index}`}>
          {Array.from({ length: 12 }, (_, cellIndex) => (
            <TableCell key={cellIndex}>
              <Skeleton className="h-4 w-16" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
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
}: {
  health: Health | null
  connection: ConnectionState
  loading: boolean
  error: string
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
  const providerKeys = health
    ? health.providers?.flatMap((provider) =>
        provider.keys.map((keyInfo) => ({
          providerId: provider.id,
          providerName: provider.name,
          keyInfo,
        })),
      ) ??
      health.keys.map((keyInfo) => ({
        providerId: health.defaultProvider,
        providerName: health.defaultProvider,
        keyInfo,
      }))
    : []

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
              <h1 className="text-3xl font-semibold sm:text-4xl">
                {t.title}
              </h1>
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
              ? `${t.meta.upstream} ${health.upstream} · ${t.meta.port} ${health.port} · ${t.meta.uptime} ${health.uptime}s · ${t.meta.gateway} v${health.version}`
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

        <Tabs defaultValue="dashboard" className="flex flex-col gap-5">
          <TabsList variant="line">
            <TabsTrigger value="dashboard">
              <LayoutDashboardIcon data-icon="inline-start" />
              {t.navigation.dashboard}
            </TabsTrigger>
            <TabsTrigger value="providers">
              <ServerCogIcon data-icon="inline-start" />
              {t.navigation.providers}
            </TabsTrigger>
            <TabsTrigger value="codex">
              <TerminalSquareIcon data-icon="inline-start" />
              {t.navigation.codex}
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

            <Card>
          <CardHeader className="border-b">
            <div>
              <CardDescription>{t.keyPool}</CardDescription>
              <CardTitle>{t.connectionHealth}</CardTitle>
            </div>
            <CardAction className="font-mono text-xs text-muted-foreground">
              {health ? t.keysSynced(providerKeys.length) : t.waitingForKeys}
            </CardAction>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="min-w-[1160px]">
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="sticky left-0 z-10 bg-muted/50">
                    {t.columns.provider}
                  </TableHead>
                  <TableHead>
                    {t.columns.key}
                  </TableHead>
                  <TableHead>{t.columns.state}</TableHead>
                  <TableHead>{t.columns.balance}</TableHead>
                  <TableHead>{t.columns.inFlight}</TableHead>
                  <TableHead>{t.columns.requests}</TableHead>
                  <TableHead>{t.columns.success}</TableHead>
                  <TableHead>{t.columns.errors}</TableHead>
                  <TableHead>{t.columns.rateLimited}</TableHead>
                  <TableHead>{t.columns.failures}</TableHead>
                  <TableHead>{t.columns.cooldown}</TableHead>
                  <TableHead>{t.columns.lastUsed}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !health ? <LoadingRows /> : null}
                {!loading && providerKeys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="p-0">
                      <Empty className="rounded-none border-0">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <KeyRoundIcon />
                          </EmptyMedia>
                          <EmptyTitle>{t.noKeys}</EmptyTitle>
                          <EmptyDescription>
                            {t.noKeysDescription}
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                ) : null}
                {providerKeys.map(({ providerId, providerName, keyInfo }) => (
                  <TableRow key={`${providerId}:${keyInfo.name}`}>
                    <TableCell className="sticky left-0 z-10 bg-card font-mono font-medium">
                      <span className="flex flex-col gap-0.5">
                        <span>{providerName}</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {providerId}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="font-mono font-medium">
                      {keyInfo.name}
                    </TableCell>
                    <TableCell>
                      <StatusBadge keyInfo={keyInfo} locale={locale} />
                    </TableCell>
                    <BalanceCell keyInfo={keyInfo} locale={locale} />
                    <TableCell className="font-mono tabular-nums">
                      {keyInfo.inFlight}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {keyInfo.total}
                    </TableCell>
                    <TableCell className="font-mono text-primary tabular-nums">
                      {keyInfo.success}
                    </TableCell>
                    <TableCell className="font-mono text-destructive tabular-nums">
                      {keyInfo.errors}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {keyInfo.ratelimited}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {keyInfo.failureCount}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {keyInfo.cooldownSec ? `${keyInfo.cooldownSec}s` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">
                      {keyInfo.lastUsed
                        ? new Date(keyInfo.lastUsed).toLocaleTimeString(locale)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
            </Card>

            <footer className="flex justify-between gap-4 font-mono text-xs text-muted-foreground">
              <span>{t.autoRefresh}</span>
              <span>Codex Provider Gateway</span>
            </footer>
          </TabsContent>
          <TabsContent value="providers" className="pt-2">
            <ProviderManager locale={locale} />
          </TabsContent>
          <TabsContent value="codex" className="pt-2">
            <CodexSetup locale={locale} />
          </TabsContent>
        </Tabs>
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
    />
  )
}

export default App
