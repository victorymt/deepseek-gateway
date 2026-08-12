import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  ActivityIcon,
  ArrowLeftIcon,
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
  PowerIcon,
  SearchIcon,
  ServerCogIcon,
  SlidersHorizontalIcon,
  Settings2Icon,
  StarIcon,
  SunIcon,
  TerminalSquareIcon,
  Trash2Icon,
} from "lucide-react"

import { CodexSetup } from "@/components/codex-setup"
import { GatewaySettingsPanel } from "@/components/gateway-settings"
import { useLanguage, type Locale } from "@/components/language-provider"
import { OperationsPanel } from "@/components/operations-panel"
import { ProviderManager } from "@/components/provider-manager"
import { useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { ProviderKeySection } from "@/features/provider-keys/provider-key-section"
import type { Health, ProviderConfig } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"
import { formatNumber } from "@/lib/format-number"

type ConnectionState = "connecting" | "live" | "offline" | "auth"

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

function ProviderWorkspace({
  health,
  loading,
  locale,
  onRefresh,
}: {
  health: Health | null
  loading: boolean
  locale: Locale
  onRefresh: () => Promise<void>
}) {
  const [query, setQuery] = useState("")
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [detailTab, setDetailTab] = useState<"overview" | "models" | "usage" | "keys" | "settings">("overview")
  const [detailVisible, setDetailVisible] = useState(false)
  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [actionError, setActionError] = useState("")
  useEffect(() => {
    const timer = window.setTimeout(() => void apiRequest<ProviderConfig>("/api/providers").then(setConfig).catch(cause => setActionError(cause instanceof Error ? cause.message : "Request failed")), 0)
    return () => window.clearTimeout(timer)
  }, [])
  const providers = health?.providers?.length
    ? health.providers
    : health
      ? [{
          id: health.defaultProvider,
          name: health.defaultProvider,
          baseUrl: health.upstream || "",
          upstreamFormat: "responses" as const,
          enabled: true,
          balanceQueryEnabled: false,
          modelCount: 0,
          total: health.total,
          keys: health.keys,
        }]
      : []
  const visibleProviders = providers.filter((provider) =>
    (!enabledOnly || provider.enabled) &&
    (provider.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
      provider.id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  )
  const [selectedId, setSelectedId] = useState(health?.defaultProvider || providers[0]?.id || "")
  const selected = providers.find((provider) => provider.id === selectedId) || providers[0]
  const totals = selected?.total || { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 }
  const requestCount = totals.requests || 0
  const configured = config?.providers.find(provider => provider.id === selected?.id)

  async function patchSelected(payload: Record<string, unknown>) {
    if (!selected) return
    try {
      setConfig(await apiRequest<ProviderConfig>(`/api/providers/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify(payload) }))
      setActionError("")
      await onRefresh()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Request failed") }
  }

  async function deleteSelected() {
    if (!selected) return
    try {
      setConfig(await apiRequest<ProviderConfig>(`/api/providers/${encodeURIComponent(selected.id)}`, { method: "DELETE" }))
      setSelectedId("")
      await onRefresh()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Request failed") }
  }

  return (
    <div className="provider-workspace">
      <div className="provider-list-pane">
        <div className="workspace-heading">
          <h1>{locale === "zh-CN" ? "提供方" : "Providers"}</h1>
          <span className="provider-count">{providers.length}</span>
        </div>
        <div className="provider-search-row">
          <label className="provider-search">
            <SearchIcon size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={locale === "zh-CN" ? "搜索提供商..." : "Search providers..."} />
          </label>
          <button className={`filter-button ${enabledOnly ? "active" : ""}`} aria-label={locale === "zh-CN" ? "仅显示已启用" : "Show enabled only"} aria-pressed={enabledOnly} onClick={() => setEnabledOnly((value) => !value)}><SlidersHorizontalIcon size={18} /></button>
        </div>
        <div className="provider-group-label">{locale === "zh-CN" ? "就绪" : "READY"}<span>{visibleProviders.length}</span></div>
        <div className="provider-list">
          {loading && !providers.length ? (
            <div className="provider-list-loading">{locale === "zh-CN" ? "正在加载..." : "Loading..."}</div>
          ) : visibleProviders.map((provider) => (
            <button key={provider.id} className={`provider-list-item ${provider.id === selected?.id ? "selected" : ""}`} aria-pressed={provider.id === selected?.id} onClick={() => { setSelectedId(provider.id); setDetailVisible(true) }}>
              <span className="provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</span>
              <span className="provider-list-copy"><strong>{provider.name}</strong><small>{locale === "zh-CN" ? `${provider.modelCount || provider.keys.length} 个模型` : `${provider.modelCount || provider.keys.length} ${(provider.modelCount || provider.keys.length) === 1 ? "model" : "models"}`}</small></span>
              {provider.id === health?.defaultProvider && <StarIcon className="provider-star" aria-label={locale === "zh-CN" ? "默认提供方" : "Default provider"} />}
              <span className={`status-dot ${provider.enabled ? "online" : "offline"}`} aria-label={provider.enabled ? (locale === "zh-CN" ? "已启用" : "Enabled") : (locale === "zh-CN" ? "已停用" : "Disabled")} />
            </button>
          ))}
        </div>
      </div>
      <div className={`provider-detail-pane ${detailVisible ? "mobile-visible" : ""}`}>
        {actionError && <p className="provider-action-error">{actionError}</p>}
        <div className="detail-topbar">
          <button className="back-button" aria-label={locale === "zh-CN" ? "返回提供方列表" : "Back to providers"} title={locale === "zh-CN" ? "返回提供方列表" : "Back to providers"} onClick={() => setDetailVisible(false)}><ArrowLeftIcon /></button>
          <h2>{locale === "zh-CN" ? "提供商概览" : "Provider overview"}</h2>
          <Button className="add-provider-button" onClick={() => window.dispatchEvent(new CustomEvent("open-provider-manager"))}>+ {locale === "zh-CN" ? "添加提供方" : "Add provider"}</Button>
        </div>
        {selected ? (
          <>
            <div className="provider-identity">
              <span className="provider-logo large">{selected.name.slice(0, 1).toUpperCase()}</span>
              <h3>{selected.name}</h3>
              <div className="detail-actions"><Button variant="outline" size="sm" disabled={selected.id === health?.defaultProvider} onClick={() => void patchSelected({ makeDefault: true })}>{locale === "zh-CN" ? "设为默认" : "Set default"}</Button><AlertDialog><AlertDialogTrigger render={<Button className="provider-delete-button" variant="outline" size="icon-sm" aria-label={locale === "zh-CN" ? "删除提供方" : "Delete provider"} />}><Trash2Icon /></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{locale === "zh-CN" ? "删除提供方？" : "Delete provider?"}</AlertDialogTitle><AlertDialogDescription>{locale === "zh-CN" ? "此操作会删除提供方及其密钥配置。" : "This removes the provider and its key configuration."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{locale === "zh-CN" ? "取消" : "Cancel"}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void deleteSelected()}>{locale === "zh-CN" ? "删除" : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><label className="enabled-control"><span className="enabled-label">{selected.enabled ? (locale === "zh-CN" ? "已启用" : "Enabled") : (locale === "zh-CN" ? "已停用" : "Disabled")}</span><Switch checked={selected.enabled} aria-label={locale === "zh-CN" ? `${selected.name} 启用状态` : `${selected.name} enabled state`} disabled={selected.id === health?.defaultProvider} onCheckedChange={checked => void patchSelected({ enabled: checked })} /></label></div>
            </div>
            <nav className="detail-tabs"><button className={detailTab === "overview" ? "active" : ""} onClick={() => setDetailTab("overview")}>{locale === "zh-CN" ? "概览" : "Overview"}</button><button className={detailTab === "models" ? "active" : ""} onClick={() => setDetailTab("models")}>{locale === "zh-CN" ? "模型" : "Models"}</button><button className={detailTab === "usage" ? "active" : ""} onClick={() => setDetailTab("usage")}>{locale === "zh-CN" ? "用量" : "Usage"}</button><button className={detailTab === "keys" ? "active" : ""} onClick={() => setDetailTab("keys")}>{locale === "zh-CN" ? "API 密钥" : "API keys"}</button><button className={detailTab === "settings" ? "active" : ""} onClick={() => setDetailTab("settings")}>{locale === "zh-CN" ? "设置" : "Settings"}</button></nav>
            {detailTab === "overview" ? <div className="detail-grid">
              <section className="detail-section"><h4>{locale === "zh-CN" ? "连接" : "Connection"}</h4><dl><div><dt>{locale === "zh-CN" ? "状态" : "Status"}</dt><dd className="success-text">✓ {selected.enabled ? (locale === "zh-CN" ? "已连接" : "Connected") : (locale === "zh-CN" ? "已停用" : "Disabled")}</dd></div><div><dt>Base URL</dt><dd className="mono">{selected.baseUrl || "-"}</dd></div><div><dt>{locale === "zh-CN" ? "认证" : "Auth"}</dt><dd>{locale === "zh-CN" ? "API 密钥" : "API key"}</dd></div><div><dt>{locale === "zh-CN" ? "默认模型（可选）" : "Default model"}</dt><dd>{health?.defaultModel || "-"}</dd></div></dl><button className="edit-link" onClick={() => window.dispatchEvent(new CustomEvent("open-provider-manager"))}>{locale === "zh-CN" ? "编辑设置" : "Edit settings"}</button></section>
              <section className="detail-section"><h4>{locale === "zh-CN" ? "运行统计" : "Runtime totals"}</h4><dl><div><dt>{locale === "zh-CN" ? "请求" : "Requests"}</dt><dd>{formatNumber(requestCount, locale)}</dd></div><div><dt>{locale === "zh-CN" ? "成功" : "Success"}</dt><dd>{formatNumber(totals.success, locale)}</dd></div><div><dt>{locale === "zh-CN" ? "错误" : "Errors"}</dt><dd>{formatNumber(totals.errors, locale)}</dd></div><div><dt>{locale === "zh-CN" ? "令牌" : "Tokens"}</dt><dd>{formatNumber(totals.tokens, locale)}</dd></div></dl><button className="edit-link" onClick={() => setDetailTab("usage")}>{locale === "zh-CN" ? "查看详细用量 →" : "View usage →"}</button></section>
              <section className="detail-section speed-section"><h4>{locale === "zh-CN" ? "可用资源" : "Available resources"}</h4><dl><div><dt>{locale === "zh-CN" ? "模型" : "Models"}</dt><dd>{formatNumber(selected.modelCount || configured?.models.length || 0, locale)}</dd></div><div><dt>API keys</dt><dd>{formatNumber(selected.keys.length, locale)}</dd></div><div><dt>{locale === "zh-CN" ? "限流" : "Rate limited"}</dt><dd>{formatNumber(totals.ratelimited, locale)}</dd></div></dl></section>
              <section className="detail-section auth-section"><h4>{locale === "zh-CN" ? "认证" : "Authentication"}</h4><p className="auth-status"><span className={`status-dot ${selected.keys.length ? "online" : "offline"}`} /> {selected.keys.length ? (locale === "zh-CN" ? `${selected.keys.length} 个 API 密钥已配置` : `${selected.keys.length} API ${selected.keys.length === 1 ? "key" : "keys"} configured`) : (locale === "zh-CN" ? "尚未配置 API 密钥" : "No API keys configured")}</p></section>
            </div> : detailTab === "models" ? (
              configured?.models.length ? (
                <section className="provider-model-list">
                  {configured.models.map(model => <div key={model.alias}><span><strong>{model.name}</strong><small>{model.alias} → {model.upstreamModel}</small></span>{health?.defaultModel === model.alias ? <Badge>{locale === "zh-CN" ? "默认" : "Default"}</Badge> : <Button variant="ghost" size="sm" onClick={() => void patchSelected({ makeDefault: true, defaultModel: model.alias })}>{locale === "zh-CN" ? "设为默认" : "Set default"}</Button>}</div>)}
                </section>
              ) : (
                <section className="tab-summary">
                  <div><h4>{locale === "zh-CN" ? "暂无模型" : "No models configured"}</h4><p>{locale === "zh-CN" ? "在提供方管理中添加模型。" : "Add a model in provider management."}</p></div>
                  <Button variant="outline" onClick={() => window.dispatchEvent(new CustomEvent("open-provider-manager"))}>{locale === "zh-CN" ? "打开管理" : "Open management"}</Button>
                </section>
              )
            ) : detailTab === "keys" ? (
              <div className="provider-keys-tab"><ProviderKeySection provider={selected} locale={locale} copy={translations[locale]} onRefresh={onRefresh} /></div>
            ) : detailTab === "usage" ? (
              <section className="detail-summary-tab">
                <h4>{locale === "zh-CN" ? "运行时用量" : "Runtime usage"}</h4>
                <div className="detail-summary-grid">
                  {[
                    [locale === "zh-CN" ? "请求" : "Requests", totals.requests],
                    [locale === "zh-CN" ? "成功" : "Success", totals.success],
                    [locale === "zh-CN" ? "错误" : "Errors", totals.errors],
                    [locale === "zh-CN" ? "限流" : "Rate limited", totals.ratelimited],
                    [locale === "zh-CN" ? "令牌" : "Tokens", totals.tokens],
                  ].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{formatNumber(Number(value), locale)}</strong></div>)}
                </div>
                {!requestCount && <p className="muted-note">{locale === "zh-CN" ? "此提供方还没有运行时用量数据。" : "No runtime usage has been recorded for this provider."}</p>}
              </section>
            ) : (
              <section className="detail-settings-tab detail-section">
                <h4>{locale === "zh-CN" ? "提供方设置" : "Provider settings"}</h4>
                <dl>
                  <div><dt>Base URL</dt><dd className="mono">{selected.baseUrl || "-"}</dd></div>
                  <div><dt>{locale === "zh-CN" ? "上游格式" : "Upstream format"}</dt><dd>{selected.upstreamFormat}</dd></div>
                  <div><dt>{locale === "zh-CN" ? "余额查询" : "Balance query"}</dt><dd>{selected.balanceQueryEnabled ? (locale === "zh-CN" ? "已启用" : "Enabled") : (locale === "zh-CN" ? "已停用" : "Disabled")}</dd></div>
                </dl>
                <Button variant="outline" onClick={() => window.dispatchEvent(new CustomEvent("open-provider-manager"))}>{locale === "zh-CN" ? "编辑提供方" : "Edit provider"}</Button>
              </section>
            )}
          </>
        ) : <div className="empty-provider-detail">{locale === "zh-CN" ? "暂无提供方" : "No providers configured"}</div>}
      </div>
    </div>
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
  const [activeSection, setActiveSection] = useState<"dashboard" | "providers" | "settings" | "codex" | "models" | "agents" | "logs" | "usage" | "storage" | "integrations">("providers")
  const [managerOpen, setManagerOpen] = useState(false)
  useEffect(() => {
    const open = () => { setManagerOpen(true); setActiveSection("providers") }
    window.addEventListener("open-provider-manager", open)
    return () => window.removeEventListener("open-provider-manager", open)
  }, [])
  const totals = health?.total ?? { requests: 0, success: 0, errors: 0, ratelimited: 0, tokens: 0 }
  const navItems = [
    { id: "dashboard" as const, label: t.navigation.dashboard, icon: LayoutDashboardIcon },
    { id: "codex" as const, label: locale === "zh-CN" ? "Codex 认证" : "Codex auth", icon: KeyRoundIcon },
    { id: "providers" as const, label: t.navigation.providers, icon: ServerCogIcon },
    { id: "models" as const, label: locale === "zh-CN" ? "模型" : "Models", icon: BoxIcon },
    { id: "agents" as const, label: locale === "zh-CN" ? "子代理" : "Subagents", icon: BotIcon },
    { id: "logs" as const, label: locale === "zh-CN" ? "日志与调试" : "Logs & debug", icon: TerminalSquareIcon },
    { id: "usage" as const, label: locale === "zh-CN" ? "用量" : "Usage", icon: ActivityIcon },
    { id: "storage" as const, label: locale === "zh-CN" ? "存储" : "Storage", icon: DatabaseIcon },
    { id: "integrations" as const, label: locale === "zh-CN" ? "集成" : "Integrations", icon: Globe2Icon },
    { id: "settings" as const, label: t.navigation.settings, icon: Settings2Icon },
  ]
  const renderContent = () => {
    if (health?.setupRequired) return <ProviderManager locale={locale} setupMode onConfigured={onRefresh} />
    if (activeSection === "settings") return <section className="workspace-page form-workspace"><GatewaySettingsPanel locale={locale} /></section>
    if (activeSection === "codex") return <section className="workspace-page"><CodexSetup locale={locale} /></section>
    if (["models", "agents", "logs", "usage", "storage", "integrations"].includes(activeSection)) return <OperationsPanel kind={activeSection as "models" | "agents" | "logs" | "usage" | "storage" | "integrations"} locale={locale} health={health} />
    if (activeSection === "dashboard") return <section className="overview-dashboard"><div className="overview-title"><h1>{locale === "zh-CN" ? "仪表盘" : "Dashboard"}</h1><ConnectionBadge state={connection} locale={locale} /></div><div className="overview-metrics">{[
      [t.metrics.requests, totals.requests], [t.metrics.success, totals.success], [t.metrics.errors, totals.errors], [t.metrics.rateLimited, totals.ratelimited], [t.metrics.tokens, totals.tokens],
    ].map(([label, value]) => <MetricCard key={String(label)} label={String(label)} value={Number(value)} note={t.metrics.lifetime} badge={t.metrics.total} loading={loading} locale={locale} />)}</div></section>
    if (managerOpen) return <section className="manager-page"><button className="manager-back" onClick={() => setManagerOpen(false)}><ArrowLeftIcon aria-hidden="true" />{locale === "zh-CN" ? "返回提供方概览" : "Back to provider overview"}</button><ProviderManager locale={locale} /></section>
    return <ProviderWorkspace health={health} loading={loading} locale={locale} onRefresh={onRefresh} />
  }

  return (
    <main className="app-shell">
      <aside className="app-sidebar" aria-label={locale === "zh-CN" ? "应用侧栏" : "Application sidebar"}>
        <div className="sidebar-brand"><BrandMark /><span>opencodex</span><small>v2.12.0</small></div>
        <nav className="sidebar-nav" aria-label={locale === "zh-CN" ? "主导航" : "Main navigation"}>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`sidebar-item ${activeSection === id ? "active" : ""}`} aria-label={label} title={label} aria-current={activeSection === id ? "page" : undefined} onClick={() => { setActiveSection(id); setManagerOpen(false) }}><Icon aria-hidden="true" /><span>{label}</span></button>)}</nav>
        <div className="sidebar-bottom"><button className="sidebar-item" aria-label={locale === "zh-CN" ? "Switch to English" : "切换到中文"} title={locale === "zh-CN" ? "Switch to English" : "切换到中文"} onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}><LanguagesIcon aria-hidden="true" /><span>{locale === "zh-CN" ? "中文" : "English"}</span><ChevronRightIcon className="item-end" aria-hidden="true" /></button><button className="sidebar-item" aria-label={locale === "zh-CN" ? "切换界面主题" : "Change interface theme"} title={locale === "zh-CN" ? "切换界面主题" : "Change interface theme"} onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}><MonitorIcon aria-hidden="true" /><span>{theme === "system" ? (locale === "zh-CN" ? "跟随系统" : "System theme") : theme === "light" ? (locale === "zh-CN" ? "浅色" : "Light") : (locale === "zh-CN" ? "深色" : "Dark")}</span></button><button className="sidebar-item danger" aria-label={locale === "zh-CN" ? "停止 Gateway" : "Stop gateway"} title={locale === "zh-CN" ? "停止 Gateway" : "Stop gateway"} onClick={() => void apiRequest("/api/runtime/stop", { method: "POST" }).catch(cause => window.alert(cause instanceof Error ? cause.message : "Request failed"))}><PowerIcon aria-hidden="true" /><span>{locale === "zh-CN" ? "停止 Gateway" : "Stop gateway"}</span></button></div>
      </aside>
      <section className="app-main">
        <div className="shell-toolbar"><div className="toolbar-status" title={error}><span className={`status-dot ${connection === "live" ? "online" : "offline"}`} />{connection === "live" ? (locale === "zh-CN" ? "网关已连接" : "Gateway connected") : error ? t.alertTitle : (locale === "zh-CN" ? "正在连接" : "Connecting")}</div>{(activeSection !== "providers" || managerOpen) && <div className="toolbar-actions"><Button variant="outline" size="icon" aria-label={t.logout} title={t.logout} onClick={() => window.location.assign("/logout")}><LogOutIcon /></Button></div>}</div>
        {renderContent()}
      </section>
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
      if (!(response.headers.get("content-type") || "").includes("application/json")) {
        throw new Error("Gateway health returned a non-JSON response")
      }
      const nextHealth = (await response.json()) as Health
      if (sequence !== requestSequence.current) return
      setHealth(nextHealth)
      setConnection("live")
      setError("")
      setLoading(false)
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
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
