import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileCode2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  TerminalIcon,
} from "lucide-react"

import type { Locale } from "@/components/language-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { CodexArtifacts } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"
import {
  appliedCodexRevision,
  markCodexRevisionApplied,
} from "@/lib/setup-actions"

const copy = {
  en: {
    title: "Codex configuration",
    description: "Apply the current gateway models to Codex.",
    refresh: "Refresh artifacts",
    failed: "Generation failed",
    copied: "Copied",
    copyFailed: "Could not copy to the clipboard",
    copy: "Copy",
    download: "Download",
    config: "config.toml",
    catalog: "gateway-models.json",
    authEnabled: "Gateway authentication is enabled",
    authEnabledDescription:
      "Set this environment variable before starting Codex.",
    authDisabled: "Gateway authentication is disabled",
    authDisabledDescription:
      "Codex can connect without a gateway token environment variable.",
    provider: "Provider",
    defaultModel: "Default model",
    catalogPath: "Catalog path",
    applyTitle: "Apply in your terminal",
    applyDescription:
      "Run this command from the gateway directory, then restart Codex.",
    applied: "Marked as applied",
    markApplied: "Mark current version as applied",
    current: "Current configuration is marked as applied",
    manual: "Manual configuration",
  },
  "zh-CN": {
    title: "Codex 配置",
    description: "将当前 Gateway 模型配置应用到 Codex。",
    refresh: "刷新配置",
    failed: "生成失败",
    copied: "已复制",
    copyFailed: "无法复制到剪贴板",
    copy: "复制",
    download: "下载",
    config: "config.toml",
    catalog: "gateway-models.json",
    authEnabled: "Gateway 已启用认证",
    authEnabledDescription: "启动 Codex 前请设置以下环境变量。",
    authDisabled: "Gateway 当前未启用认证",
    authDisabledDescription: "Codex 无需 Gateway Token 环境变量即可连接。",
    provider: "Provider",
    defaultModel: "默认模型",
    catalogPath: "模型目录路径",
    applyTitle: "在终端中应用",
    applyDescription: "在 Gateway 目录执行以下命令，然后重启 Codex。",
    applied: "已标记为应用",
    markApplied: "标记当前版本为已应用",
    current: "当前配置已标记为应用",
    manual: "手动配置",
  },
} as const

async function fetchArtifacts() {
  return apiRequest<CodexArtifacts>("/api/codex/config")
}

function downloadText(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function CodexSetup({ locale }: { locale: Locale }) {
  const t = copy[locale]
  const [artifacts, setArtifacts] = useState<CodexArtifacts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [appliedRevision, setAppliedRevision] = useState(appliedCodexRevision)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setArtifacts(await fetchArtifacts())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setLoading(false)
    }
  }, [t.failed])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setError("")
      setNotice(t.copied)
      window.setTimeout(() => setNotice(""), 1600)
    } catch {
      setNotice("")
      setError(t.copyFailed)
    }
  }

  function markApplied() {
    if (!artifacts) return
    markCodexRevisionApplied(artifacts.revision)
    setAppliedRevision(artifacts.revision)
    setNotice(t.applied)
    window.setTimeout(() => setNotice(""), 1600)
  }

  const environmentLine =
    artifacts?.authRequired && artifacts.envKey
      ? `export ${artifacts.envKey}="<gateway-token>"`
      : ""

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{t.title}</h2>
          <p className="text-sm text-muted-foreground">{t.description}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t.refresh}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t.failed}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <CheckIcon />
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      )}

      {loading && !artifacts ? (
        <Skeleton className="h-[34rem] w-full" />
      ) : artifacts ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TerminalIcon />
                {t.applyTitle}
              </CardTitle>
              <CardDescription>{t.applyDescription}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 border-t pt-4">
              <div className="flex min-w-0 items-center gap-3 rounded-md bg-muted px-4 py-3">
                <code className="min-w-0 flex-1 break-all text-sm">
                  ./gatewayctl codex
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.copy}
                  title={t.copy}
                  onClick={() => void copyText("./gatewayctl codex")}
                >
                  <CopyIcon />
                </Button>
              </div>
              {appliedRevision === artifacts.revision ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2Icon className="size-4 text-primary" />
                  {t.current}
                </p>
              ) : (
                <Button className="self-start" onClick={markApplied}>
                  <CheckIcon data-icon="inline-start" />
                  {t.markApplied}
                </Button>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1 border-l-2 border-primary pl-3">
              <span className="text-xs text-muted-foreground">
                {t.provider}
              </span>
              <span className="font-mono text-sm">{artifacts.providerId}</span>
            </div>
            <div className="flex flex-col gap-1 border-l-2 border-primary pl-3">
              <span className="text-xs text-muted-foreground">
                {t.defaultModel}
              </span>
              <span className="font-mono text-sm break-all">
                {artifacts.defaultModel}
              </span>
            </div>
            <div className="flex flex-col gap-1 border-l-2 border-primary pl-3">
              <span className="text-xs text-muted-foreground">
                {t.catalogPath}
              </span>
              <span className="font-mono text-sm break-all">
                {artifacts.modelsPath}
              </span>
            </div>
          </div>

          {artifacts.authRequired ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheckIcon />
                  {t.authEnabled}
                </CardTitle>
                <CardDescription>{t.authEnabledDescription}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3 border-t pt-4">
                <code className="min-w-0 text-xs break-all">
                  {environmentLine}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.copy}
                  title={t.copy}
                  onClick={() => void copyText(environmentLine)}
                >
                  <CopyIcon />
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Alert>
              <ShieldOffIcon />
              <AlertTitle>{t.authDisabled}</AlertTitle>
              <AlertDescription>{t.authDisabledDescription}</AlertDescription>
            </Alert>
          )}

          <details className="codex-manual-config">
            <summary>{t.manual}</summary>
          <Tabs defaultValue="config" className="min-w-0 pt-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="max-w-full overflow-x-auto">
                <TabsList className="codex-artifact-tabs">
                <TabsTrigger value="config" className="codex-artifact-tab">{t.config}</TabsTrigger>
                <TabsTrigger value="catalog" className="codex-artifact-tab">{t.catalog}</TabsTrigger>
                </TabsList>
              </div>
              <Badge className="max-w-full truncate" variant="outline" title={artifacts.gatewayUrl}>{artifacts.gatewayUrl}</Badge>
            </div>
            <TabsContent value="config" className="pt-3">
              <Card>
                <CardHeader>
                  <CardTitle>{t.config}</CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.copy}
                      title={t.copy}
                      onClick={() => void copyText(artifacts.configToml)}
                    >
                      <CopyIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.download}
                      title={t.download}
                      onClick={() =>
                        downloadText(
                          "gateway-config.toml",
                          artifacts.configToml,
                          "text/plain"
                        )
                      }
                    >
                      <DownloadIcon />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="min-w-0">
                  <Textarea
                    readOnly
                    value={artifacts.configToml}
                    className="h-80 resize-none font-mono text-xs"
                    aria-label={t.config}
                  />
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="catalog" className="pt-3">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileCode2Icon />
                    {t.catalog}
                  </CardTitle>
                  <CardAction className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.copy}
                      title={t.copy}
                      onClick={() => void copyText(artifacts.catalogJson)}
                    >
                      <CopyIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.download}
                      title={t.download}
                      onClick={() =>
                        downloadText(
                          "gateway-models.json",
                          artifacts.catalogJson,
                          "application/json"
                        )
                      }
                    >
                      <DownloadIcon />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="min-w-0">
                  <Textarea
                    readOnly
                    value={artifacts.catalogJson}
                    className="h-80 resize-none font-mono text-xs"
                    aria-label={t.catalog}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
          </details>
        </>
      ) : null}
    </section>
  )
}
