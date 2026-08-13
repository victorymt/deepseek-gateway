import type { ReactNode } from "react"
import { CheckIcon, RefreshCwIcon } from "lucide-react"

import type { Locale } from "@/components/language-provider"
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
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { OperationsKind } from "./types"

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

export function OperationsPageShell({
  kind,
  locale,
  loading,
  error,
  notice,
  onRefresh,
  refreshSeconds,
  onRefreshSecondsChange,
  children,
}: {
  kind: OperationsKind
  locale: Locale
  loading: boolean
  error: string
  notice: string
  onRefresh: () => void
  refreshSeconds?: number
  onRefreshSecondsChange?: (seconds: number) => void
  children: ReactNode
}) {
  const zh = locale === "zh-CN"
  return (
    <section className="operations-panel">
      <div className="operations-header">
        <div>
          <p className="eyebrow">{zh ? "运维中心" : "OPERATIONS"}</p>
          <h1>{labels[locale][kind]}</h1>
          <p className="operations-description">{descriptions[locale][kind]}</p>
        </div>
        <div className="operations-header-actions">
          {refreshSeconds !== undefined && onRefreshSecondsChange && (
            <Select
              value={String(refreshSeconds)}
              onValueChange={(value) => onRefreshSecondsChange(Number(value))}
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
            onClick={onRefresh}
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
            <Button size="sm" variant="outline" onClick={onRefresh}>
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
      {children}
    </section>
  )
}

export function ConfirmAction({
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
  children: ReactNode
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
