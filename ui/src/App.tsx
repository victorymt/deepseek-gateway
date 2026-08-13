import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  BoxIcon,
  BotIcon,
  CircleDotIcon,
  ChevronRightIcon,
  DatabaseIcon,
  Globe2Icon,
  LayoutDashboardIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LogOutIcon,
  MoonIcon,
  MonitorIcon,
  MenuIcon,
  PowerIcon,
  ServerCogIcon,
  Settings2Icon,
  SunIcon,
  TerminalSquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { CodexSetup } from "@/components/codex-setup"
import {
  isOperationsSection,
  sectionFromHash,
  sectionHash,
  type Section,
} from "@/app-navigation"
import { GatewaySettingsPanel } from "@/components/gateway-settings"
import { useLanguage, type Locale } from "@/components/language-provider"
import { OperationsPanel } from "@/components/operations-panel"
import { ProviderManager } from "@/components/provider-manager"
import { ProviderWorkspace as ManagedProviderWorkspace } from "@/components/provider-workspace"
import { useTheme } from "@/components/theme-provider"
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
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import type { Health } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"
import { formatNumber } from "@/lib/format-number"
import { notifyConfigChanged, useSetupActions } from "@/lib/setup-actions"
import { ToastProvider } from "@/components/toast"

type ConnectionState = "connecting" | "live" | "offline" | "auth"
const HISTORY_INDEX_KEY = "deepseekGatewayIndex"
const HISTORY_SCOPE_KEY = "deepseekGatewayScope"

function createHistoryScope() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function historyIndex(state: unknown, scope: string): number | null {
  if (!state || typeof state !== "object") return null
  const entry = state as Record<string, unknown>
  if (entry[HISTORY_SCOPE_KEY] !== scope) return null
  const value = entry[HISTORY_INDEX_KEY]
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function historyState(index: number, scope: string) {
  return {
    ...(window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {}),
    [HISTORY_INDEX_KEY]: index,
    [HISTORY_SCOPE_KEY]: scope,
  }
}

const translations = {
  en: {
    themeToLight: "Switch to light mode",
    themeToDark: "Switch to dark mode",
    languageToggle: "切换到中文",
    privateConsole: "PRIVATE CONSOLE",
    loginTitle: "Sign in to console",
    loginDescription: "Use your admin token to continue.",
    tokenLabel: "Admin token",
    tokenPlaceholder: "Enter token",
    login: "Sign in",
    logout: "Sign out",
    invalidToken: "Incorrect token",
    rateLimited: (seconds: number) =>
      `Too many attempts. Try again in ${seconds}s.`,
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
    discard: "Discard changes",
    discardChanges: "Discard unsaved key changes?",
    deleteKeyTitle: "Delete key?",
    deleteKeyDescription: (name: string) =>
      `The key ${name} will be removed from this provider immediately.`,
    actionFailed: "Key action failed",
    balanceRefreshed: "Balance refreshed",
    keyUpdated: "Key updated and applied",
    importKeys: "Import keys",
    importKeysTitle: "Import gateway keys",
    importKeysDescription: (provider: string) =>
      `Add keys to ${provider} in one batch.`,
    importText: "Paste text",
    importFile: "Upload file",
    importPlaceholder: "One key per line, or name=key / name:key",
    chooseFile: "Choose TXT or JSON file",
    importFileHint:
      "Accepts text files and JSON arrays of strings or key objects.",
    importFileTooLarge: "The selected file exceeds the 1 MiB limit.",
    importFileTypeInvalid: "Choose a TXT or JSON file.",
    importEnabled: "Enable imported keys",
    importAlwaysTry: "Always try imported keys",
    importSubmit: "Import keys",
    importFailed: "Key import failed",
    importSummary: (added: number, ignored: number) =>
      `Imported ${added} ${added === 1 ? "key" : "keys"}; ignored ${ignored}.`,
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
    loginDescription: "使用管理令牌继续。",
    tokenLabel: "管理令牌",
    tokenPlaceholder: "输入令牌",
    login: "登录",
    logout: "退出登录",
    invalidToken: "令牌不正确",
    rateLimited: (seconds: number) =>
      `登录尝试过多，请在 ${seconds} 秒后重试。`,
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
    discard: "放弃更改",
    discardChanges: "放弃尚未保存的密钥修改？",
    deleteKeyTitle: "删除密钥？",
    deleteKeyDescription: (name: string) =>
      `密钥 ${name} 将立即从当前 Provider 中移除。`,
    actionFailed: "密钥操作失败",
    balanceRefreshed: "额度已刷新",
    keyUpdated: "密钥已更新并生效",
    importKeys: "批量导入",
    importKeysTitle: "批量导入 Gateway 密钥",
    importKeysDescription: (provider: string) =>
      `向 ${provider} 一次添加多个密钥。`,
    importText: "粘贴文本",
    importFile: "上传文件",
    importPlaceholder: "每行一个密钥，也支持 name=key 或 name:key",
    chooseFile: "选择 TXT 或 JSON 文件",
    importFileHint: "支持文本文件，以及字符串数组或密钥对象数组。",
    importFileTooLarge: "所选文件超过 1 MiB 上限。",
    importFileTypeInvalid: "请选择 TXT 或 JSON 文件。",
    importEnabled: "启用导入的密钥",
    importAlwaysTry: "始终尝试导入的密钥",
    importSubmit: "导入密钥",
    importFailed: "密钥导入失败",
    importSummary: (added: number, ignored: number) =>
      `已导入 ${added} 个密钥，忽略 ${ignored} 个。`,
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

function LoginView() {
  const { locale } = useLanguage()
  const t = translations[locale]
  const [token, setToken] = useState("")
  const [error, setError] = useState<
    "" | "invalidToken" | "rateLimited" | "cannotConnect"
  >("")
  const [retryAfter, setRetryAfter] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError("")
    setRetryAfter(0)

    try {
      const response = await fetch("/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      })
      if (response.status === 429) {
        const header = response.headers.get("retry-after")
        const seconds = Number(header)
        const retryAt = header ? Date.parse(header) : Number.NaN
        setRetryAfter(
          Number.isFinite(seconds)
            ? Math.max(1, Math.ceil(seconds))
            : Number.isFinite(retryAt)
              ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
              : 60
        )
        setError("rateLimited")
        return
      }
      if (!response.ok) {
        setError(response.status === 401 ? "invalidToken" : "cannotConnect")
        return
      }
      window.location.assign("/")
    } catch {
      setError("cannotConnect")
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = window.setInterval(() => {
      setRetryAfter((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [retryAfter])

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
                  {error && (
                    <FieldError>
                      {error === "rateLimited"
                        ? t.rateLimited(retryAfter)
                        : t[error]}
                    </FieldError>
                  )}
                </Field>
              </FieldGroup>
              <Button type="submit" disabled={submitting || retryAfter > 0}>
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
  const { locale, setLocale } = useLanguage()
  const { theme, setTheme } = useTheme()
  const t = translations[locale]
  const [activeSection, setActiveSectionState] = useState<Section>(() =>
    typeof window === "undefined"
      ? "providers"
      : sectionFromHash(window.location.hash)
  )
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [dirtySources, setDirtySources] = useState<Record<string, boolean>>({})
  const [pendingSection, setPendingSection] = useState<Section | null>(null)
  const [pendingHistoryIndex, setPendingHistoryIndex] = useState<number | null>(
    null
  )
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null)
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0)
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  const [stopDialogOpen, setStopDialogOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const [stopMessage, setStopMessage] = useState("")
  const [stopError, setStopError] = useState("")
  const historyScopeRef = useRef(createHistoryScope())
  const historyIndexRef = useRef(0)
  const restoringHistoryRef = useRef(false)
  const allowedHistoryNavigationRef = useRef(false)
  const popstateUrlRef = useRef<string | null>(null)
  const allowUnloadRef = useRef(false)
  const hasDirty = Object.values(dirtySources).some(Boolean)
  const setupActions = useSetupActions(!health?.setupRequired)
  const totals = health?.total ?? {
    requests: 0,
    success: 0,
    errors: 0,
    ratelimited: 0,
    tokens: 0,
  }
  const activeRequests =
    health?.providers.reduce(
      (total, provider) =>
        total + provider.keys.reduce((sum, key) => sum + key.inFlight, 0),
      0
    ) ?? 0
  const navGroups = [
    {
      label: locale === "zh-CN" ? "配置" : "CONFIGURE",
      items: [
        {
          id: "providers" as const,
          label: t.navigation.providers,
          icon: ServerCogIcon,
        },
        {
          id: "codex" as const,
          label: locale === "zh-CN" ? "Codex 配置" : "Codex configuration",
          icon: KeyRoundIcon,
        },
      ],
    },
    {
      label: locale === "zh-CN" ? "运行状态" : "OPERATIONS",
      items: [
        {
          id: "dashboard" as const,
          label: t.navigation.dashboard,
          icon: LayoutDashboardIcon,
        },
        {
          id: "usage" as const,
          label: locale === "zh-CN" ? "用量" : "Usage",
          icon: ActivityIcon,
        },
        {
          id: "logs" as const,
          label: locale === "zh-CN" ? "日志与调试" : "Logs & debug",
          icon: TerminalSquareIcon,
        },
      ],
    },
    {
      label: locale === "zh-CN" ? "高级" : "ADVANCED",
      items: [
        {
          id: "models" as const,
          label: locale === "zh-CN" ? "模型" : "Models",
          icon: BoxIcon,
        },
        {
          id: "agents" as const,
          label: locale === "zh-CN" ? "子代理" : "Subagents",
          icon: BotIcon,
        },
        {
          id: "storage" as const,
          label: locale === "zh-CN" ? "存储" : "Storage",
          icon: DatabaseIcon,
        },
        {
          id: "integrations" as const,
          label: locale === "zh-CN" ? "集成" : "Integrations",
          icon: Globe2Icon,
        },
        {
          id: "settings" as const,
          label: t.navigation.settings,
          icon: Settings2Icon,
        },
      ],
    },
  ]
  const commitSection = useCallback((next: Section, replace = false) => {
    setActiveSectionState(next)
    const url = sectionHash(next)
    if (replace) {
      window.history.replaceState(
        historyState(historyIndexRef.current, historyScopeRef.current),
        "",
        url
      )
    } else {
      historyIndexRef.current += 1
      window.history.pushState(
        historyState(historyIndexRef.current, historyScopeRef.current),
        "",
        url
      )
    }
    setMobileNavOpen(false)
  }, [])

  const navigateTo = useCallback(
    (next: Section) => {
      if (health?.setupRequired && next !== "providers") return
      if (next === activeSection) return
      if (
        hasDirty &&
        !(isOperationsSection(activeSection) && isOperationsSection(next))
      ) {
        setPendingLocale(null)
        setPendingSection(next)
        setPendingHistoryIndex(null)
        setLeaveDialogOpen(true)
        return
      }
      commitSection(next)
    },
    [activeSection, commitSection, hasDirty, health?.setupRequired]
  )

  const reportDirty = useCallback((source: string, dirty: boolean) => {
    setDirtySources((current) => {
      if (current[source] === dirty) return current
      return { ...current, [source]: dirty }
    })
  }, [])

  const reportSettingsDirty = useCallback(
    (dirty: boolean) => {
      reportDirty("settings", dirty)
    },
    [reportDirty]
  )

  const reportProvidersDirty = useCallback(
    (dirty: boolean) => {
      reportDirty("providers", dirty)
    },
    [reportDirty]
  )

  const reportOperationsDirty = useCallback(
    (source: string, dirty: boolean) => {
      reportDirty(`operations:${source}`, dirty)
    },
    [reportDirty]
  )

  useEffect(() => {
    const handleHash = (event?: Event) => {
      if (event?.type === "hashchange") {
        if (popstateUrlRef.current === window.location.href) {
          popstateUrlRef.current = null
          return
        }
        popstateUrlRef.current = null
      } else if (event?.type === "popstate") {
        popstateUrlRef.current = window.location.href
      }
      const next = sectionFromHash(window.location.hash)
      let targetIndex = historyIndex(
        window.history.state,
        historyScopeRef.current
      )
      if (restoringHistoryRef.current && next === activeSection) {
        restoringHistoryRef.current = false
        return
      }
      if (allowedHistoryNavigationRef.current) {
        allowedHistoryNavigationRef.current = false
        if (targetIndex !== null) historyIndexRef.current = targetIndex
        setActiveSectionState(next)
        return
      }
      if (health?.setupRequired && next !== "providers") {
        commitSection("providers", true)
        return
      }
      if (next === activeSection) {
        if (targetIndex !== null) historyIndexRef.current = targetIndex
        return
      }
      {
        if (
          hasDirty &&
          !(isOperationsSection(activeSection) && isOperationsSection(next))
        ) {
          if (targetIndex === null && event?.type === "popstate") {
            const nextScope = createHistoryScope()
            historyScopeRef.current = nextScope
            targetIndex = -1
            window.history.replaceState(
              historyState(targetIndex, nextScope),
              "",
              window.location.href
            )
            historyIndexRef.current = 0
            window.history.pushState(
              historyState(0, nextScope),
              "",
              sectionHash(activeSection)
            )
          } else if (
            targetIndex === null ||
            targetIndex === historyIndexRef.current
          ) {
            targetIndex = historyIndexRef.current + 1
            window.history.replaceState(
              historyState(targetIndex, historyScopeRef.current),
              "",
              window.location.href
            )
          }
          if (targetIndex !== -1) {
            restoringHistoryRef.current = true
            window.history.go(historyIndexRef.current - targetIndex)
          }
          setPendingLocale(null)
          setPendingSection(next)
          setPendingHistoryIndex(targetIndex)
          setLeaveDialogOpen(true)
          return
        }
        if (targetIndex === null && event?.type === "popstate") {
          historyScopeRef.current = createHistoryScope()
          historyIndexRef.current = 0
          targetIndex = 0
          window.history.replaceState(
            historyState(targetIndex, historyScopeRef.current),
            "",
            window.location.href
          )
        } else if (
          targetIndex === null ||
          targetIndex === historyIndexRef.current
        ) {
          targetIndex = historyIndexRef.current + 1
          window.history.replaceState(
            historyState(targetIndex, historyScopeRef.current),
            "",
            window.location.href
          )
        }
        historyIndexRef.current = targetIndex
        setActiveSectionState(next)
      }
    }
    window.addEventListener("hashchange", handleHash)
    window.addEventListener("popstate", handleHash)
    window.history.replaceState(
      historyState(historyIndexRef.current, historyScopeRef.current),
      "",
      window.location.hash || sectionHash(activeSection)
    )
    const timer = window.setTimeout(handleHash, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("hashchange", handleHash)
      window.removeEventListener("popstate", handleHash)
    }
  }, [activeSection, commitSection, hasDirty, health?.setupRequired])

  useEffect(() => {
    if (!stopRequested || connection !== "offline") return
    const timer = window.setTimeout(() => {
      setStopping(false)
      setStopRequested(false)
      setStopMessage(locale === "zh-CN" ? "Gateway 已停止" : "Gateway stopped")
    }, 0)
    return () => window.clearTimeout(timer)
  }, [connection, locale, stopRequested])

  useEffect(() => {
    if (!stopRequested) return
    const poll = window.setInterval(() => void onRefresh(), 400)
    const timer = window.setTimeout(() => {
      setStopping(false)
      setStopRequested(false)
      setStopMessage(
        locale === "zh-CN"
          ? "已发送停止请求，但尚未确认 Gateway 已离线"
          : "Stop requested, but Gateway has not been confirmed offline"
      )
    }, 8000)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(timer)
    }
  }, [locale, onRefresh, stopRequested])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirty || allowUnloadRef.current) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [hasDirty])

  async function confirmStop() {
    setStopping(true)
    setStopMessage("")
    setStopError("")
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8000)
    try {
      await apiRequest("/api/runtime/stop", {
        method: "POST",
        signal: controller.signal,
      })
      setStopDialogOpen(false)
      setStopRequested(true)
    } catch (cause) {
      setStopping(false)
      setStopError(
        controller.signal.aborted
          ? locale === "zh-CN"
            ? "停止请求超时，请检查 Gateway 状态后重试"
            : "The stop request timed out. Check the Gateway status and try again."
          : cause instanceof Error
            ? cause.message
            : locale === "zh-CN"
              ? "停止失败"
              : "Stop failed"
      )
    } finally {
      window.clearTimeout(timer)
    }
  }

  function requestLogout() {
    if (hasDirty) {
      setPendingSection(null)
      setPendingHistoryIndex(null)
      setPendingLocale(null)
      setLeaveDialogOpen(true)
      return
    }
    window.location.assign("/logout")
  }

  function requestLanguageChange() {
    const next = locale === "zh-CN" ? "en" : "zh-CN"
    if (hasDirty) {
      setPendingSection(null)
      setPendingHistoryIndex(null)
      setPendingLocale(next)
      setLeaveDialogOpen(true)
      return
    }
    setLocale(next)
  }

  const renderContent = () => {
    if (health?.setupRequired)
      return (
        <ProviderManager
          locale={locale}
          setupMode
          onConfigured={onRefresh}
          onChanged={notifyConfigChanged}
          onDirtyChange={reportProvidersDirty}
        />
      )
    if (activeSection === "settings")
      return (
        <section className="workspace-page form-workspace">
          <GatewaySettingsPanel
            locale={locale}
            onDirtyChange={reportSettingsDirty}
          />
        </section>
      )
    if (activeSection === "codex")
      return (
        <section className="workspace-page">
          <CodexSetup locale={locale} />
        </section>
      )
    if (
      ["models", "agents", "logs", "usage", "storage", "integrations"].includes(
        activeSection
      )
    )
      return (
        <OperationsPanel
          kind={
            activeSection as
              | "models"
              | "agents"
              | "logs"
              | "usage"
              | "storage"
              | "integrations"
          }
          locale={locale}
          health={health}
          onDirtyChange={reportOperationsDirty}
        />
      )
    if (activeSection === "dashboard")
      return (
        <section className="overview-dashboard">
          <div className="overview-title">
            <h1>{locale === "zh-CN" ? "仪表盘" : "Dashboard"}</h1>
            <ConnectionBadge state={connection} locale={locale} />
          </div>
          <div className="overview-metrics">
            {[
              [t.metrics.requests, totals.requests],
              [t.metrics.success, totals.success],
              [t.metrics.errors, totals.errors],
              [t.metrics.rateLimited, totals.ratelimited],
              [t.metrics.tokens, totals.tokens],
            ].map(([label, value]) => (
              <MetricCard
                key={String(label)}
                label={String(label)}
                value={Number(value)}
                note={t.metrics.lifetime}
                badge={t.metrics.total}
                loading={loading}
                locale={locale}
              />
            ))}
          </div>
        </section>
      )
    return (
      <ManagedProviderWorkspace
        health={health}
        locale={locale}
        keyCopy={t}
        onRefresh={onRefresh}
        onDirtyChange={reportProvidersDirty}
      />
    )
  }

  return (
    <main className="app-shell">
      <aside
        className="app-sidebar"
        aria-label={locale === "zh-CN" ? "应用侧栏" : "Application sidebar"}
      >
        <div className="sidebar-brand">
          <BrandMark />
          <span>deepseek-gateway</span>
          <small>{health?.version || "v2"}</small>
          <button
            className="mobile-nav-close"
            aria-label={locale === "zh-CN" ? "关闭导航" : "Close navigation"}
            onClick={() => setMobileNavOpen(false)}
          >
            <XIcon />
          </button>
        </div>
        <nav
          className="sidebar-nav"
          aria-label={locale === "zh-CN" ? "主导航" : "Main navigation"}
        >
          {navGroups.map((group) => (
            <div className="sidebar-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map(({ id, label, icon: Icon }) => {
                const blocked = Boolean(
                  health?.setupRequired && id !== "providers"
                )
                return (
                  <button
                    key={id}
                    className={`sidebar-item ${activeSection === id ? "active" : ""}`}
                    aria-label={label}
                    title={
                      blocked
                        ? locale === "zh-CN"
                          ? "完成首个 Provider 配置后解锁"
                          : "Configure your first Provider to unlock"
                        : label
                    }
                    aria-current={activeSection === id ? "page" : undefined}
                    disabled={blocked}
                    onClick={() => navigateTo(id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="sidebar-item"
            aria-label={locale === "zh-CN" ? "Switch to English" : "切换到中文"}
            title={locale === "zh-CN" ? "Switch to English" : "切换到中文"}
            onClick={requestLanguageChange}
          >
            <LanguagesIcon aria-hidden="true" />
            <span>{locale === "zh-CN" ? "中文" : "English"}</span>
            <ChevronRightIcon className="item-end" aria-hidden="true" />
          </button>
          <button
            className="sidebar-item"
            aria-label={
              locale === "zh-CN" ? "切换界面主题" : "Change interface theme"
            }
            title={
              locale === "zh-CN" ? "切换界面主题" : "Change interface theme"
            }
            onClick={() =>
              setTheme(
                theme === "system"
                  ? "light"
                  : theme === "light"
                    ? "dark"
                    : "system"
              )
            }
          >
            <MonitorIcon aria-hidden="true" />
            <span>
              {theme === "system"
                ? locale === "zh-CN"
                  ? "跟随系统"
                  : "System theme"
                : theme === "light"
                  ? locale === "zh-CN"
                    ? "浅色"
                    : "Light"
                  : locale === "zh-CN"
                    ? "深色"
                    : "Dark"}
            </span>
          </button>
          <button
            className="sidebar-item danger"
            aria-label={locale === "zh-CN" ? "停止 Gateway" : "Stop gateway"}
            title={locale === "zh-CN" ? "停止 Gateway" : "Stop gateway"}
            disabled={stopping}
            onClick={() => setStopDialogOpen(true)}
          >
            <PowerIcon aria-hidden="true" />
            <span>
              {stopping
                ? locale === "zh-CN"
                  ? "停止中..."
                  : "Stopping..."
                : locale === "zh-CN"
                  ? "停止 Gateway"
                  : "Stop gateway"}
            </span>
          </button>
        </div>
      </aside>
      {mobileNavOpen && (
        <button
          className="mobile-nav-backdrop"
          aria-label={locale === "zh-CN" ? "关闭导航" : "Close navigation"}
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <section className="app-main">
        <div className="shell-toolbar">
          <Button
            className="mobile-nav-trigger"
            variant="ghost"
            size="icon"
            aria-label={locale === "zh-CN" ? "打开导航" : "Open navigation"}
            onClick={() => setMobileNavOpen(true)}
          >
            <MenuIcon />
          </Button>
          <div className="toolbar-status" title={error}>
            <span
              className={`status-dot ${connection === "live" ? "online" : "offline"}`}
            />
            {connection === "live"
              ? locale === "zh-CN"
                ? "网关已连接"
                : "Gateway connected"
              : error
                ? t.alertTitle
                : locale === "zh-CN"
                  ? "正在连接"
                  : "Connecting"}
          </div>
          <div className="toolbar-actions">
            <Button
              variant="outline"
              size="icon"
              aria-label={t.logout}
              title={t.logout}
              onClick={requestLogout}
            >
              <LogOutIcon />
            </Button>
          </div>
        </div>
        {(setupActions.restartRequired.length > 0 ||
          setupActions.codexPending) && (
          <div className="pending-actions" role="status">
            <TriangleAlertIcon aria-hidden="true" />
            <div>
              <strong>
                {locale === "zh-CN"
                  ? "配置尚需操作"
                  : "Configuration needs action"}
              </strong>
              {setupActions.restartRequired.length > 0 && (
                <span>
                  {locale === "zh-CN"
                    ? `重启 Gateway 以应用：${setupActions.restartRequired.join("、")}`
                    : `Restart Gateway to apply: ${setupActions.restartRequired.join(", ")}`}
                </span>
              )}
              {setupActions.codexPending && (
                <span>
                  {locale === "zh-CN"
                    ? "重新执行 ./gatewayctl codex，然后重启 Codex"
                    : "Run ./gatewayctl codex again, then restart Codex"}
                </span>
              )}
            </div>
            <div className="pending-action-buttons">
              {setupActions.restartRequired.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigateTo("settings")}
                >
                  {locale === "zh-CN" ? "查看设置" : "View settings"}
                </Button>
              )}
              {setupActions.codexPending && (
                <Button size="sm" onClick={() => navigateTo("codex")}>
                  {locale === "zh-CN"
                    ? "打开 Codex 配置"
                    : "Open Codex configuration"}
                </Button>
              )}
            </div>
          </div>
        )}
        <div key={workspaceGeneration}>{renderContent()}</div>
        {stopMessage && (
          <div className="px-4 pb-4" role="status">
            <div className="rounded-lg border px-3 py-2 text-sm">
              {stopMessage}
            </div>
          </div>
        )}
      </section>
      <AlertDialog
        open={leaveDialogOpen}
        onOpenChange={(open) => {
          setLeaveDialogOpen(open)
          if (open) return
          setPendingSection(null)
          setPendingHistoryIndex(null)
          setPendingLocale(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {locale === "zh-CN"
                ? "放弃未保存更改？"
                : "Discard unsaved changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {locale === "zh-CN"
                ? "当前页面有未保存的输入，离开后这些内容将丢失。"
                : "This page has unsaved input that will be lost if you leave."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {locale === "zh-CN" ? "继续编辑" : "Keep editing"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setLeaveDialogOpen(false)
                setDirtySources({})
                setWorkspaceGeneration((current) => current + 1)
                if (pendingHistoryIndex !== null) {
                  allowedHistoryNavigationRef.current = true
                  window.history.go(
                    pendingHistoryIndex - historyIndexRef.current
                  )
                } else if (pendingSection) commitSection(pendingSection)
                else if (pendingLocale) setLocale(pendingLocale)
                else {
                  allowUnloadRef.current = true
                  window.location.assign("/logout")
                }
                setPendingSection(null)
                setPendingHistoryIndex(null)
                setPendingLocale(null)
              }}
            >
              {locale === "zh-CN" ? "放弃并离开" : "Discard and leave"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={stopDialogOpen}
        onOpenChange={(open) => {
          if (stopping) return
          setStopDialogOpen(open)
          if (!open) setStopError("")
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {locale === "zh-CN" ? "停止 Gateway？" : "Stop Gateway?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {locale === "zh-CN"
                ? `停止后当前代理请求会中断，面板也会暂时离线。当前有 ${activeRequests} 个请求正在处理。${hasDirty ? "未保存的更改也会丢失。" : ""}`
                : `Stopping will interrupt active proxy requests and take the console offline. ${activeRequests} request(s) are currently in flight.${hasDirty ? " Unsaved changes will also be lost." : ""}`}
            </AlertDialogDescription>
            {stopError && (
              <p className="text-sm text-destructive" role="alert">
                {stopError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>
              {locale === "zh-CN" ? "取消" : "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={stopping}
              onClick={() => void confirmStop()}
            >
              {stopping && <Spinner data-icon="inline-start" />}
              {stopping
                ? locale === "zh-CN"
                  ? "停止中..."
                  : "Stopping..."
                : locale === "zh-CN"
                  ? "停止 Gateway"
                  : "Stop Gateway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const activeRequest = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      const response = await fetch("/health", {
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
      if (sequence !== requestSequence.current) return
      if (response.status === 401) {
        setConnection("auth")
        setLoading(false)
        return
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      if (
        !(response.headers.get("content-type") || "").includes(
          "application/json"
        )
      ) {
        throw new Error("Gateway health returned a non-JSON response")
      }
      const nextHealth = (await response.json()) as Health
      if (sequence !== requestSequence.current) return
      setHealth(nextHealth)
      setConnection("live")
      setError("")
      setLoading(false)
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current)
        return
      setConnection("offline")
      setLoading(false)
      setError(cause instanceof Error ? cause.message : "Unknown error")
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer = 0
    const poll = async () => {
      await refresh()
      if (!stopped && !document.hidden) {
        timer = window.setTimeout(poll, 7500)
      }
    }
    const handleVisibility = () => {
      if (!document.hidden) {
        window.clearTimeout(timer)
        void poll()
      } else {
        window.clearTimeout(timer)
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)
    void poll()
    return () => {
      stopped = true
      document.removeEventListener("visibilitychange", handleVisibility)
      window.clearTimeout(timer)
      activeRequest.current?.abort()
    }
  }, [refresh])

  if (connection === "auth") {
    return <LoginView />
  }

  return (
    <ToastProvider>
      <Dashboard
        health={health}
        connection={connection}
        loading={loading}
        error={error}
        onRefresh={refresh}
      />
    </ToastProvider>
  )
}

export default App
