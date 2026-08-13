import { useCallback, useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GatewayLogEntry, LogsPage } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { downloadCsv } from "./csv-download"
import { ConfirmAction, OperationsPageShell } from "./page-shell"
import { useOperationsAutoRefresh, useOperationsPage } from "./page-state"
import type { OperationsPageProps } from "./types"

const emptyPage: LogsPage = {
  logs: [],
  total: 0,
  hasMore: false,
  nextCursor: null,
}

export default function LogsPage({ locale, active }: OperationsPageProps) {
  const zh = locale === "zh-CN"
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState("")
  const [provider, setProvider] = useState("")
  const [model, setModel] = useState("")
  const [status, setStatus] = useState("")
  const [cursor, setCursor] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [selectedLog, setSelectedLog] = useState<GatewayLogEntry | null>(null)
  const [refreshSeconds, setRefreshSeconds] = useState(0)

  const load = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({ limit: "50" })
      if (query) params.set("search", query)
      if (level) params.set("level", level)
      if (provider) params.set("provider", provider)
      if (model) params.set("model", model)
      if (status) params.set("status", status)
      if (cursor) params.set("cursor", cursor)
      return apiRequest<LogsPage>(`/api/logs?${params}`, { signal })
    },
    [query, level, provider, model, status, cursor]
  )
  const page = useOperationsPage(load, active, emptyPage)
  const logsPage = page.data
  useOperationsAutoRefresh(
    page.refresh,
    refreshSeconds,
    Boolean(selectedLog),
    active
  )

  function resetPagination() {
    setCursor("")
    setHistory([])
  }

  return (
    <OperationsPageShell
      kind="logs"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
      refreshSeconds={refreshSeconds}
      onRefreshSecondsChange={setRefreshSeconds}
    >
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
                void page.action(
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
                  resetPagination()
                  setQuery(event.target.value)
                }}
                placeholder={zh ? "搜索日志..." : "Search logs..."}
              />
            </label>
            <Select
              value={level || "all"}
              onValueChange={(value) => {
                resetPagination()
                setLevel(value === "all" ? "" : String(value))
              }}
            >
              <SelectTrigger aria-label={zh ? "日志级别" : "Log level"}>
                <SelectValue placeholder={zh ? "级别" : "Level"} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">
                    {zh ? "全部级别" : "All levels"}
                  </SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="audit">audit</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Input
              aria-label={zh ? "Provider 筛选" : "Provider filter"}
              value={provider}
              onChange={(event) => {
                resetPagination()
                setProvider(event.target.value)
              }}
              placeholder="Provider"
            />
            <Input
              aria-label={zh ? "模型筛选" : "Model filter"}
              value={model}
              onChange={(event) => {
                resetPagination()
                setModel(event.target.value)
              }}
              placeholder={zh ? "模型" : "Model"}
            />
            <Input
              aria-label={zh ? "状态码筛选" : "Status filter"}
              value={status}
              onChange={(event) => {
                resetPagination()
                setStatus(event.target.value.replace(/\D/g, ""))
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
                  logsPage.logs.map((log) => [
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
              disabled={!logsPage.logs.length}
            >
              <DownloadIcon data-icon="inline-start" />
              {zh ? "导出 CSV" : "Export CSV"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="log-list">
            {logsPage.logs.map((log) => (
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
          {!page.loading && !logsPage.logs.length && (
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
              disabled={!history.length || page.loading}
              onClick={() => {
                const next = [...history]
                setCursor(next.pop() || "")
                setHistory(next)
              }}
            >
              <ChevronLeftIcon data-icon="inline-start" />
              {zh ? "上一页" : "Previous"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !logsPage.hasMore || page.loading || !logsPage.nextCursor
              }
              onClick={() => {
                setHistory((current) => [...current, cursor])
                setCursor(logsPage.nextCursor || "")
              }}
            >
              {zh ? "下一页" : "Next"}
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </div>
        </CardContent>
      </Card>
      {selectedLog && (
        <AlertDialog
          open
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
                <dt>{zh ? "时间" : "Timestamp"}</dt>
                <dd>
                  {new Date(selectedLog.timestamp).toLocaleString(locale)}
                </dd>
              </div>
              <div>
                <dt>{zh ? "路由" : "Route"}</dt>
                <dd>
                  {selectedLog.method} {selectedLog.route}
                </dd>
              </div>
              <div>
                <dt>{zh ? "状态" : "Status"}</dt>
                <dd>{selectedLog.status ?? "-"}</dd>
              </div>
              <div>
                <dt>{zh ? "Provider / 模型" : "Provider / model"}</dt>
                <dd>
                  {selectedLog.provider || "-"} / {selectedLog.model || "-"}
                </dd>
              </div>
              <div>
                <dt>{zh ? "耗时" : "Latency"}</dt>
                <dd>{selectedLog.latencyMs ?? "-"} ms</dd>
              </div>
            </dl>
            <AlertDialogFooter>
              <AlertDialogCancel>{zh ? "关闭" : "Close"}</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </OperationsPageShell>
  )
}
