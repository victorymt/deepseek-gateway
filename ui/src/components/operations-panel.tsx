import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type FormEvent,
} from "react"
import {
  ArchiveIcon,
  ChartNoAxesCombinedIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
  WifiIcon,
} from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { Locale } from "@/components/language-provider"
import type {
  GatewayLogEntry,
  Integration,
  LogsPage,
  ProviderConfig,
  StorageInfo,
  Subagent,
  UsageResponse,
} from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"
import { draftAfterSubmit } from "./operations-draft-state"
import { toCsv } from "./operations-export"

type OperationsKind =
  "models" | "agents" | "logs" | "usage" | "storage" | "integrations"
type IntegrationDraft = {
  id?: string
  name: string
  type: string
  baseUrl: string
  enabled: boolean
}
type SubagentDraft = {
  id?: string
  name: string
  description: string
  providerId: string
  model: string
  developerInstructions: string
  enabled: boolean
}

const labels = {
  en: {
    models: "Models",
    agents: "Subagents",
    logs: "Logs & debug",
    usage: "Usage",
    storage: "Storage",
    integrations: "Integrations",
  },
  "zh-CN": {
    models: "模型",
    agents: "子代理",
    logs: "日志与调试",
    usage: "用量",
    storage: "存储",
    integrations: "集成",
  },
} as const

const descriptions = {
  en: {
    models: "Review model aliases, upstream targets, and request activity.",
    agents:
      "Create and maintain native Codex subagents and their projected files.",
    logs: "Search gateway requests and inspect errors, routing, and latency.",
    usage: "Track requests, tokens, and usage by provider or model.",
    storage: "Back up, restore, and inspect the gateway configuration store.",
    integrations: "Configure and test external webhook integrations.",
  },
  "zh-CN": {
    models: "查看模型别名、上游目标和请求活动。",
    agents: "创建并维护 Codex 原生子代理及其投影文件。",
    logs: "搜索 Gateway 请求，并检查错误、路由和延迟。",
    usage: "按 Provider 或模型查看请求数、令牌数和用量。",
    storage: "备份、恢复并检查 Gateway 配置存储。",
    integrations: "配置并测试外部 Webhook 集成。",
  },
} as const

function ConfirmAction({
  title,
  description,
  action,
  children,
  destructive = false,
  iconOnly = false,
  zh = false,
}: {
  title: string
  description: string
  action: () => void
  children: React.ReactNode
  destructive?: boolean
  iconOnly?: boolean
  zh?: boolean
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant={destructive ? "destructive" : "ghost"}
            size={iconOnly ? "icon-sm" : "sm"}
            aria-label={title}
            title={title}
          />
        }
      >
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{zh ? "取消" : "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={action}
          >
            {zh ? "确认" : "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function OperationsPanel({
  kind,
  locale,
  health,
}: {
  kind: OperationsKind
  locale: Locale
  health: {
    providers: Array<{
      id: string
      name: string
      modelCount: number
      total: { requests: number; tokens: number }
      keys: unknown[]
    }>
    defaultModel: string
  } | null
}) {
  const t = labels[locale][kind]
  const description = descriptions[locale][kind]
  const zh = locale === "zh-CN"
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  const [logs, setLogs] = useState<GatewayLogEntry[]>([])
  const [logsPage, setLogsPage] = useState<LogsPage>({
    logs: [],
    total: 0,
    hasMore: false,
    nextCursor: null,
  })
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [subagents, setSubagents] = useState<Subagent[]>([])
  const [providerConfig, setProviderConfig] = useState<ProviderConfig | null>(
    null
  )
  const [query, setQuery] = useState("")
  const [logLevel, setLogLevel] = useState("")
  const [logProvider, setLogProvider] = useState("")
  const [logModel, setLogModel] = useState("")
  const [logStatus, setLogStatus] = useState("")
  const [logCursor, setLogCursor] = useState("")
  const [logHistory, setLogHistory] = useState<string[]>([])
  const [selectedLog, setSelectedLog] = useState<GatewayLogEntry | null>(null)
  const [range, setRange] = useState("30d")
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  const previousKind = useRef(kind)
  const [integrationDraft, setIntegrationDraft] =
    useState<IntegrationDraft | null>(null)
  const [subagentDraft, setSubagentDraft] = useState<SubagentDraft | null>(null)

  const refresh = useCallback(
    async (cursor = logCursor) => {
      setLoading(true)
      setError("")
      try {
        if (previousKind.current !== kind) {
          cursor = ""
          setLogCursor("")
          setLogHistory([])
          previousKind.current = kind
        }
        if (kind === "logs") {
          const params = new URLSearchParams({ limit: "50" })
          if (query) params.set("search", query)
          if (logLevel) params.set("level", logLevel)
          if (logProvider) params.set("provider", logProvider)
          if (logModel) params.set("model", logModel)
          if (logStatus) params.set("status", logStatus)
          if (cursor) params.set("cursor", cursor)
          const page = await apiRequest<LogsPage>(`/api/logs?${params}`)
          setLogs(page.logs)
          setLogsPage(page)
        }
        if (kind === "models" || kind === "agents")
          setProviderConfig(await apiRequest<ProviderConfig>("/api/providers"))
        if (kind === "usage")
          setUsage(await apiRequest<UsageResponse>(`/api/usage?range=${range}`))
        if (kind === "storage")
          setStorage(await apiRequest<StorageInfo>("/api/storage"))
        if (kind === "integrations")
          setIntegrations(
            (
              await apiRequest<{ integrations: Integration[] }>(
                "/api/integrations"
              )
            ).integrations
          )
        if (kind === "agents")
          setSubagents(
            (await apiRequest<{ subagents: Subagent[] }>("/api/subagents"))
              .subagents
          )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Request failed")
      } finally {
        setLoading(false)
      }
    },
    [kind, query, logLevel, logProvider, logModel, logStatus, range, logCursor]
  )
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    if (!refreshSeconds || integrationDraft || subagentDraft || selectedLog)
      return
    const timer = window.setInterval(
      () => void refresh(),
      refreshSeconds * 1000
    )
    return () => window.clearInterval(timer)
  }, [refresh, refreshSeconds, integrationDraft, subagentDraft, selectedLog])

  function downloadCsv(
    filename: string,
    headers: string[],
    rows: Array<Array<unknown>>
  ) {
    const content = toCsv(headers, rows)
    const link = document.createElement("a")
    link.href = URL.createObjectURL(
      new Blob([`\ufeff${content}`], { type: "text/csv;charset=utf-8" })
    )
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
  }

  async function action(path: string, init?: RequestInit, message = "Saved") {
    setPendingAction(path)
    setError("")
    setNotice("")
    try {
      await apiRequest(path, init)
      setNotice(message)
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed")
      return false
    } finally {
      setPendingAction("")
    }
  }
  async function submitDraft(
    event: FormEvent<HTMLFormElement>,
    path: string,
    draft: IntegrationDraft | SubagentDraft,
    message: string
  ) {
    event.preventDefault()
    const saved = await action(
      path,
      { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(draft) },
      message
    )
    if ("baseUrl" in draft) {
      setIntegrationDraft((current) =>
        draftAfterSubmit(current, draft as IntegrationDraft, saved)
      )
    } else {
      setSubagentDraft((current) =>
        draftAfterSubmit(current, draft as SubagentDraft, saved)
      )
    }
  }

  const providerModels = useMemo(
    () =>
      providerConfig?.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          provider: provider.name,
          providerId: provider.id,
          model: model.alias,
          name: model.name,
          upstream: model.upstreamModel,
          requests:
            health?.providers.find((item) => item.id === provider.id)?.total
              .requests || 0,
          tokens:
            health?.providers.find((item) => item.id === provider.id)?.total
              .tokens || 0,
        }))
      ) || [],
    [health, providerConfig]
  )
  const selectedProvider = providerConfig?.providers.find(
    (provider) => provider.id === subagentDraft?.providerId
  )
  const enabledProviders =
    providerConfig?.providers.filter((provider) => provider.enabled) || []
  const selectableSubagentProviders =
    providerConfig?.providers.filter(
      (provider) =>
        provider.enabled || provider.id === subagentDraft?.providerId
    ) || []
  const defaultSubagentProvider =
    enabledProviders.find((provider) => provider.models.length > 0) ||
    enabledProviders[0]
  const hasUsageData = Boolean(
    usage && Object.values(usage.total).some((value) => Number(value) > 0)
  )

  return (
    <section className="operations-panel">
      <div className="operations-header">
        <div>
          <p className="eyebrow">{zh ? "运维中心" : "OPERATIONS"}</p>
          <h1>{t}</h1>
          <p className="operations-description">{description}</p>
        </div>
        <div className="operations-header-actions">
          {(kind === "logs" || kind === "usage") && (
            <Select
              value={String(refreshSeconds)}
              onValueChange={(value) => setRefreshSeconds(Number(value))}
            >
              <SelectTrigger
                aria-label={zh ? "自动刷新间隔" : "Auto refresh interval"}
              >
                <SelectValue>
                  {refreshSeconds
                    ? zh
                      ? `${refreshSeconds} 秒`
                      : `${refreshSeconds}s`
                    : zh
                      ? "自动刷新：关闭"
                      : "Auto refresh: Off"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="0">
                    {zh ? "自动刷新：关闭" : "Auto refresh: Off"}
                  </SelectItem>
                  <SelectItem value="5">
                    {zh ? "每 5 秒刷新" : "Every 5 seconds"}
                  </SelectItem>
                  <SelectItem value="15">
                    {zh ? "每 15 秒刷新" : "Every 15 seconds"}
                  </SelectItem>
                  <SelectItem value="30">
                    {zh ? "每 30 秒刷新" : "Every 30 seconds"}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={zh ? "刷新当前面板" : "Refresh current panel"}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {zh ? "刷新" : "Refresh"}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{zh ? "请求失败" : "Request failed"}</AlertTitle>
          <AlertDescription className="operation-error">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RefreshCwIcon data-icon="inline-start" />
              {zh ? "重试" : "Retry"}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <CheckIcon />
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}
      {loading && !error && (
        <p className="operation-loading" role="status">
          {zh ? "正在加载..." : "Loading..."}
        </p>
      )}
      {kind === "models" && (
        <div className="operation-grid">
          {providerModels.map((item) => (
            <Card key={`${item.providerId}:${item.model}`}>
              <CardHeader>
                <CardTitle>{item.name}</CardTitle>
                <CardDescription>
                  {item.provider} · {item.model}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p>{item.upstream}</p>
                <p>
                  {item.requests.toLocaleString(locale)} requests ·{" "}
                  {item.tokens.toLocaleString(locale)} tokens
                </p>
                <Badge variant="outline">
                  {item.model === health?.defaultModel
                    ? "Default"
                    : "Available"}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {kind === "models" && !loading && !providerModels.length && (
        <p className="empty-copy">{zh ? "暂无模型" : "No models configured"}</p>
      )}
      {kind === "logs" && (
        <Card>
          <CardHeader>
            <div className="operation-row">
              <CardTitle>
                <FileTextIcon />
                {zh ? "运行日志" : "Runtime logs"}
              </CardTitle>
              <ConfirmAction
                zh={zh}
                title={zh ? "清空日志？" : "Clear logs?"}
                description={zh ? "此操作不可撤销。" : "This cannot be undone."}
                destructive
                action={() =>
                  void action(
                    "/api/logs",
                    { method: "DELETE" },
                    zh ? "日志已清空" : "Logs cleared"
                  )
                }
              >
                <Trash2Icon data-icon="inline-start" />
                {zh ? "清空" : "Clear"}
              </ConfirmAction>
            </div>
            <div className="operation-filters">
              <label className="operation-search">
                <SearchIcon />
                <Input
                  aria-label={zh ? "搜索日志" : "Search logs"}
                  value={query}
                  onChange={(event) => {
                    setLogCursor("")
                    setLogHistory([])
                    setQuery(event.target.value)
                  }}
                  placeholder={zh ? "搜索日志..." : "Search logs..."}
                />
              </label>
              <Select
                value={logLevel || "all"}
                onValueChange={(value) => {
                  setLogCursor("")
                  setLogHistory([])
                  setLogLevel(value === "all" ? "" : String(value))
                }}
              >
                <SelectTrigger aria-label={zh ? "日志级别" : "Log level"}>
                  <SelectValue placeholder={zh ? "级别" : "Level"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {zh ? "全部级别" : "All levels"}
                  </SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="audit">audit</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label={zh ? "Provider 筛选" : "Provider filter"}
                value={logProvider}
                onChange={(event) => {
                  setLogCursor("")
                  setLogHistory([])
                  setLogProvider(event.target.value)
                }}
                placeholder="Provider"
              />
              <Input
                aria-label={zh ? "模型筛选" : "Model filter"}
                value={logModel}
                onChange={(event) => {
                  setLogCursor("")
                  setLogHistory([])
                  setLogModel(event.target.value)
                }}
                placeholder={zh ? "模型" : "Model"}
              />
              <Input
                aria-label={zh ? "状态码筛选" : "Status filter"}
                value={logStatus}
                onChange={(event) => {
                  setLogCursor("")
                  setLogHistory([])
                  setLogStatus(event.target.value.replace(/\D/g, ""))
                }}
                placeholder="HTTP"
                inputMode="numeric"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadCsv(
                    "gateway-logs.csv",
                    [
                      "timestamp",
                      "level",
                      "method",
                      "route",
                      "status",
                      "provider",
                      "model",
                      "latencyMs",
                      "message",
                    ],
                    logs.map((log) => [
                      log.timestamp,
                      log.level,
                      log.method,
                      log.route,
                      log.status,
                      log.provider,
                      log.model,
                      log.latencyMs,
                      log.message,
                    ])
                  )
                }
                disabled={!logs.length}
              >
                <DownloadIcon data-icon="inline-start" />
                {zh ? "导出 CSV" : "Export CSV"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="log-list">
              {logs.map((log) => (
                <button
                  className="log-entry log-entry-button"
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  type="button"
                >
                  <time>{new Date(log.timestamp).toLocaleString(locale)}</time>
                  <Badge
                    variant={log.level === "error" ? "destructive" : "outline"}
                  >
                    {log.level}
                  </Badge>
                  <code>{log.message}</code>
                </button>
              ))}
            </div>
            {!loading && !logs.length && (
              <p className="empty-copy">{zh ? "暂无日志" : "No logs yet"}</p>
            )}
            <div className="operation-pagination">
              <span>
                {logsPage.total.toLocaleString(locale)}{" "}
                {zh ? "条结果" : "results"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!logHistory.length || loading}
                onClick={() => {
                  const next = [...logHistory]
                  const cursor = next.pop() || ""
                  setLogHistory(next)
                  setLogCursor(cursor)
                }}
              >
                <ChevronLeftIcon />
                {zh ? "上一页" : "Previous"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!logsPage.hasMore || loading || !logsPage.nextCursor}
                onClick={() => {
                  setLogHistory((history) => [...history, logCursor])
                  setLogCursor(logsPage.nextCursor || "")
                }}
              >
                <ChevronRightIcon />
                {zh ? "下一页" : "Next"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {selectedLog && (
        <AlertDialog
          open={Boolean(selectedLog)}
          onOpenChange={(open) => !open && setSelectedLog(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {zh ? "日志详情" : "Log details"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {selectedLog.message}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <dl className="log-detail-grid">
              <div>
                <dt>Timestamp</dt>
                <dd>
                  {new Date(selectedLog.timestamp).toLocaleString(locale)}
                </dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>
                  {selectedLog.method} {selectedLog.route}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedLog.status ?? "-"}</dd>
              </div>
              <div>
                <dt>Provider / model</dt>
                <dd>
                  {selectedLog.provider || "-"} / {selectedLog.model || "-"}
                </dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{selectedLog.latencyMs ?? "-"} ms</dd>
              </div>
            </dl>
            <AlertDialogFooter>
              <AlertDialogCancel>{zh ? "关闭" : "Close"}</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {kind === "usage" && usage && (
        <Card>
          <CardHeader>
            <div className="operation-row">
              <CardTitle>{zh ? "用量趋势" : "Usage trend"}</CardTitle>
              <div className="range-buttons">
                {["24h", "7d", "30d"].map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={range === value ? "default" : "outline"}
                    onClick={() => setRange(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="usage-total-grid">
              {Object.entries(usage.total).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <strong>{Number(value).toLocaleString(locale)}</strong>
                </div>
              ))}
            </div>
            {hasUsageData ? (
              <>
                <div className="usage-chart">
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={usage.points}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="requests"
                        stroke="#248d70"
                        strokeWidth={2}
                        name={zh ? "请求" : "Requests"}
                      />
                      <Line
                        type="monotone"
                        dataKey="tokens"
                        stroke="#e29b42"
                        strokeWidth={2}
                        name={zh ? "令牌" : "Tokens"}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="usage-breakdown-grid">
                  <div>
                    <h3>{zh ? "按 Provider" : "By provider"}</h3>
                    {Object.entries(usage.providers ?? {}).map(
                      ([name, values]) => (
                        <div className="usage-breakdown-row" key={name}>
                          <span>{name}</span>
                          <strong>
                            {values.requests.toLocaleString(locale)} req ·{" "}
                            {values.tokens.toLocaleString(locale)} tok
                          </strong>
                        </div>
                      )
                    )}
                  </div>
                  <div>
                    <h3>{zh ? "按模型" : "By model"}</h3>
                    {Object.entries(usage.models ?? {}).map(
                      ([name, values]) => (
                        <div className="usage-breakdown-row" key={name}>
                          <span>{name}</span>
                          <strong>
                            {values.requests.toLocaleString(locale)} req ·{" "}
                            {values.tokens.toLocaleString(locale)} tok
                          </strong>
                        </div>
                      )
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadCsv(
                      `gateway-usage-${usage.range}.csv`,
                      [
                        "date",
                        "requests",
                        "success",
                        "errors",
                        "ratelimited",
                        "tokens",
                      ],
                      usage.points.map((point) => [
                        point.date,
                        point.requests,
                        point.success,
                        point.errors,
                        point.ratelimited,
                        point.tokens,
                      ])
                    )
                  }
                >
                  <DownloadIcon data-icon="inline-start" />
                  {zh ? "导出 CSV" : "Export CSV"}
                </Button>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ChartNoAxesCombinedIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {zh ? "暂无用量数据" : "No usage data"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {zh
                      ? "所选时间范围内还没有 Gateway 请求。"
                      : "No gateway requests were recorded in the selected range."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      )}
      {kind === "storage" && storage && (
        <Card>
          <CardHeader>
            <div className="operation-row">
              <CardTitle>
                <DatabaseIcon />
                {zh ? "配置存储" : "Configuration storage"}
              </CardTitle>
              <Button
                size="sm"
                disabled={Boolean(pendingAction)}
                onClick={() =>
                  void action(
                    "/api/storage",
                    {
                      method: "POST",
                      body: JSON.stringify({ action: "backup" }),
                    },
                    zh ? "备份已创建" : "Backup created"
                  )
                }
              >
                <ArchiveIcon data-icon="inline-start" />
                {zh ? "创建备份" : "Create backup"}
              </Button>
            </div>
            <CardDescription>{storage.configPath}</CardDescription>
          </CardHeader>
          <CardContent>
            <p>
              {storage.configSize.toLocaleString(locale)} bytes ·{" "}
              {zh
                ? `保留 ${storage.retention.backupLimit} 个备份`
                : `keep ${storage.retention.backupLimit} backups`}
            </p>
            <div className="backup-list">
              {storage.backups.map((backup) => (
                <div className="operation-row" key={backup.id}>
                  <span>
                    {new Date(backup.createdAt).toLocaleString(locale)}
                  </span>
                  <span>
                    <ConfirmAction
                      zh={zh}
                      title={zh ? "恢复配置？" : "Restore configuration?"}
                      description={
                        zh
                          ? "当前配置会先自动备份。"
                          : "The current configuration will be backed up first."
                      }
                      action={() =>
                        void action(
                          "/api/storage",
                          {
                            method: "POST",
                            body: JSON.stringify({
                              action: "restore",
                              id: backup.id,
                            }),
                          },
                          zh ? "配置已恢复" : "Configuration restored"
                        )
                      }
                    >
                      <DownloadIcon data-icon="inline-start" />
                      {zh ? "恢复" : "Restore"}
                    </ConfirmAction>
                    <ConfirmAction
                      zh={zh}
                      title={zh ? "删除备份？" : "Delete backup?"}
                      description={backup.id}
                      destructive
                      action={() =>
                        void action(
                          `/api/storage/backups/${encodeURIComponent(backup.id)}`,
                          { method: "DELETE" },
                          zh ? "备份已删除" : "Backup deleted"
                        )
                      }
                    >
                      <Trash2Icon />
                    </ConfirmAction>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {kind === "integrations" && (
        <div className="operation-stack">
          <Button
            onClick={() =>
              setIntegrationDraft({
                name: "",
                type: "openai",
                baseUrl: "",
                enabled: true,
              })
            }
          >
            <PlusIcon data-icon="inline-start" />
            {zh ? "添加集成" : "Add integration"}
          </Button>
          {integrationDraft && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {integrationDraft.id
                    ? zh
                      ? "编辑集成"
                      : "Edit integration"
                    : zh
                      ? "添加集成"
                      : "Add integration"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  className="draft-form"
                  onSubmit={(event) =>
                    submitDraft(
                      event,
                      integrationDraft.id
                        ? `/api/integrations/${integrationDraft.id}`
                        : "/api/integrations",
                      integrationDraft,
                      zh ? "集成已保存" : "Integration saved"
                    )
                  }
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="integration-name">Name</FieldLabel>
                      <Input
                        id="integration-name"
                        required
                        value={integrationDraft.name}
                        onChange={(event) =>
                          setIntegrationDraft({
                            ...integrationDraft,
                            name: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Type</FieldLabel>
                      <Select
                        value={integrationDraft.type}
                        onValueChange={(value) =>
                          setIntegrationDraft({
                            ...integrationDraft,
                            type: String(value),
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                            <SelectItem value="webhook">Webhook</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="integration-url">
                        Base URL
                      </FieldLabel>
                      <Input
                        id="integration-url"
                        required
                        type="url"
                        placeholder="https://example.com/v1"
                        value={integrationDraft.baseUrl}
                        onChange={(event) =>
                          setIntegrationDraft({
                            ...integrationDraft,
                            baseUrl: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="integration-enabled">
                        Enabled
                      </FieldLabel>
                      <Switch
                        id="integration-enabled"
                        checked={integrationDraft.enabled}
                        onCheckedChange={(checked) =>
                          setIntegrationDraft({
                            ...integrationDraft,
                            enabled: checked,
                          })
                        }
                      />
                    </Field>
                  </FieldGroup>
                  <div className="form-actions">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIntegrationDraft(null)}
                    >
                      {zh ? "取消" : "Cancel"}
                    </Button>
                    <Button type="submit" disabled={Boolean(pendingAction)}>
                      {pendingAction
                        ? zh
                          ? "保存中..."
                          : "Saving..."
                        : zh
                          ? "保存"
                          : "Save"}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
          {integrations.map((item) => (
            <Card key={item.id}>
              <CardHeader>
                <div className="operation-row">
                  <CardTitle>{item.name}</CardTitle>
                  <Badge>{item.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
                <CardDescription>
                  {item.type} · {item.baseUrl}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="operation-row">
                  <span>
                    <Switch
                      checked={item.enabled}
                      aria-label={
                        zh ? `${item.name} 启用状态` : `${item.name} enabled`
                      }
                      disabled={Boolean(pendingAction)}
                      onCheckedChange={(enabled) =>
                        void action(
                          `/api/integrations/${item.id}`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({ ...item, enabled }),
                          },
                          zh ? "状态已更新" : "Status updated"
                        )
                      }
                    />
                  </span>
                  <span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(pendingAction)}
                      onClick={() =>
                        void action(
                          `/api/integrations/${item.id}/test`,
                          { method: "POST" },
                          zh ? "集成已测试" : "Integration tested"
                        )
                      }
                    >
                      <WifiIcon data-icon="inline-start" />
                      {zh ? "测试" : "Test"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={zh ? "编辑集成" : "Edit integration"}
                      title={zh ? "编辑集成" : "Edit integration"}
                      onClick={() => setIntegrationDraft(item)}
                    >
                      <PencilIcon />
                    </Button>
                    <ConfirmAction
                      zh={zh}
                      title={zh ? "删除集成？" : "Delete integration?"}
                      description={item.name}
                      destructive
                      action={() =>
                        void action(
                          `/api/integrations/${item.id}`,
                          { method: "DELETE" },
                          zh ? "集成已删除" : "Integration deleted"
                        )
                      }
                    >
                      <Trash2Icon />
                    </ConfirmAction>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
          {!loading && !integrations.length && !integrationDraft && (
            <p className="empty-copy">
              {zh ? "暂无集成" : "No integrations configured"}
            </p>
          )}
        </div>
      )}
      {kind === "agents" && (
        <div className="operation-stack">
          <Card>
            <CardHeader>
              <CardTitle>
                <UsersIcon />
                {zh ? "Codex 原生子代理" : "Native Codex subagents"}
              </CardTitle>
              <CardDescription>
                {zh
                  ? "管理投影到 Codex agents 目录的独立代理配置。"
                  : "Manage independent agent configurations projected into the Codex agents directory."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="agent-list">
                {subagents.map((agent) => (
                  <div className="operation-row" key={agent.id}>
                    <span className="agent-summary">
                      <strong>{agent.name}</strong>
                      <span>{agent.description}</span>
                      <small>
                        {agent.providerId} · {agent.model}
                      </small>
                      <code
                        title={
                          agent.projection.path ||
                          `${agent.projection.codexHome.replace(/[\\/]+$/, "")}/agents/${agent.name}.toml`
                        }
                      >
                        agents/{agent.name}.toml
                      </code>
                    </span>
                    <span className="agent-actions">
                      <Switch
                        id={`agent-enabled-${agent.id}`}
                        checked={agent.enabled}
                        aria-label={
                          zh
                            ? `${agent.name} 启用状态`
                            : `${agent.name} enabled`
                        }
                        title={
                          agent.enabled
                            ? zh
                              ? "停用子代理"
                              : "Disable subagent"
                            : zh
                              ? "启用子代理"
                              : "Enable subagent"
                        }
                        disabled={Boolean(pendingAction)}
                        onCheckedChange={(enabled) =>
                          void action(
                            `/api/subagents/${agent.id}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({ ...agent, enabled }),
                            },
                            zh ? "状态已更新" : "Status updated"
                          )
                        }
                      />
                      <Badge
                        variant={
                          agent.projection.installed ? "default" : "outline"
                        }
                      >
                        {agent.projection.status}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          zh ? `编辑子代理 ${agent.name}` : `Edit ${agent.name}`
                        }
                        title={
                          zh ? `编辑子代理 ${agent.name}` : `Edit ${agent.name}`
                        }
                        onClick={() => setSubagentDraft(agent)}
                      >
                        <PencilIcon />
                      </Button>
                      <ConfirmAction
                        zh={zh}
                        title={
                          zh
                            ? `删除子代理 ${agent.name}？`
                            : `Delete ${agent.name}?`
                        }
                        description={agent.name}
                        destructive
                        iconOnly
                        action={() =>
                          void action(
                            `/api/subagents/${agent.id}`,
                            { method: "DELETE" },
                            zh ? "子代理已删除" : "Subagent deleted"
                          )
                        }
                      >
                        <Trash2Icon />
                      </ConfirmAction>
                    </span>
                  </div>
                ))}
              </div>
              {!subagents.length && (
                <p className="empty-copy">
                  {zh ? "暂无子代理配置" : "No subagents configured"}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                {subagentDraft?.id
                  ? zh
                    ? "编辑子代理"
                    : "Edit subagent"
                  : zh
                    ? "添加子代理"
                    : "Add subagent"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="draft-form"
                onSubmit={(event) =>
                  subagentDraft &&
                  submitDraft(
                    event,
                    subagentDraft.id
                      ? `/api/subagents/${subagentDraft.id}`
                      : "/api/subagents",
                    subagentDraft,
                    zh ? "子代理已保存" : "Subagent saved"
                  )
                }
              >
                <FieldGroup>
                  {!subagentDraft && (
                    <Button
                      type="button"
                      disabled={!defaultSubagentProvider?.models.length}
                      title={
                        defaultSubagentProvider?.models.length
                          ? undefined
                          : zh
                            ? "请先启用至少一个包含模型的 Provider"
                            : "Enable a provider with at least one model first"
                      }
                      onClick={() => {
                        const provider = defaultSubagentProvider
                        setSubagentDraft({
                          name: "",
                          description: "",
                          providerId: provider?.id || "",
                          model: provider?.models[0]?.alias || "",
                          developerInstructions: "",
                          enabled: true,
                        })
                      }}
                    >
                      <PlusIcon data-icon="inline-start" />
                      {zh ? "开始配置" : "Start configuration"}
                    </Button>
                  )}
                  {subagentDraft && (
                    <>
                      <Field>
                        <FieldLabel htmlFor="subagent-name">
                          {zh ? "名称" : "Name"}
                        </FieldLabel>
                        <Input
                          id="subagent-name"
                          required
                          value={subagentDraft.name}
                          onChange={(event) =>
                            setSubagentDraft({
                              ...subagentDraft,
                              name: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="subagent-description">
                          {zh ? "描述" : "Description"}
                        </FieldLabel>
                        <Input
                          id="subagent-description"
                          required
                          value={subagentDraft.description}
                          onChange={(event) =>
                            setSubagentDraft({
                              ...subagentDraft,
                              description: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="subagent-provider">
                          Provider
                        </FieldLabel>
                        <Select
                          value={subagentDraft.providerId}
                          onValueChange={(value) => {
                            const provider = providerConfig?.providers.find(
                              (item) => item.id === String(value)
                            )
                            setSubagentDraft({
                              ...subagentDraft,
                              providerId: String(value),
                              model: provider?.models[0]?.alias || "",
                            })
                          }}
                        >
                          <SelectTrigger id="subagent-provider">
                            <SelectValue placeholder="Provider" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {selectableSubagentProviders.map((provider) => (
                                <SelectItem
                                  key={provider.id}
                                  value={provider.id}
                                >
                                  {provider.name}
                                  {!provider.enabled &&
                                    (zh ? "（已停用）" : " (Disabled)")}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="subagent-model">
                          {zh ? "模型" : "Model"}
                        </FieldLabel>
                        <Select
                          value={subagentDraft.model}
                          onValueChange={(value) =>
                            setSubagentDraft({
                              ...subagentDraft,
                              model: String(value),
                            })
                          }
                        >
                          <SelectTrigger
                            id="subagent-model"
                            disabled={!selectedProvider?.models.length}
                          >
                            <SelectValue placeholder="Model" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {selectedProvider?.models.map((model) => (
                                <SelectItem
                                  key={model.alias}
                                  value={model.alias}
                                >
                                  {model.name}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="subagent-instructions">
                          {zh ? "开发者指令" : "Developer instructions"}
                        </FieldLabel>
                        <Textarea
                          id="subagent-instructions"
                          required
                          value={subagentDraft.developerInstructions}
                          onChange={(event) =>
                            setSubagentDraft({
                              ...subagentDraft,
                              developerInstructions: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field orientation="horizontal">
                        <FieldLabel htmlFor="subagent-enabled">
                          {zh ? "启用" : "Enabled"}
                        </FieldLabel>
                        <Switch
                          id="subagent-enabled"
                          checked={subagentDraft.enabled}
                          onCheckedChange={(enabled) =>
                            setSubagentDraft({ ...subagentDraft, enabled })
                          }
                        />
                      </Field>
                      <div className="form-actions">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setSubagentDraft(null)}
                        >
                          {zh ? "取消" : "Cancel"}
                        </Button>
                        <Button type="submit" disabled={Boolean(pendingAction)}>
                          {pendingAction
                            ? zh
                              ? "保存中..."
                              : "Saving..."
                            : zh
                              ? "保存"
                              : "Save"}
                        </Button>
                      </div>
                    </>
                  )}
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  )
}
