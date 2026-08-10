import { useCallback, useEffect, useState } from "react"
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileCode2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
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

const copy = {
  en: {
    title: "Codex setup",
    description: "multi-provider-gateway / responses",
    refresh: "Refresh artifacts",
    failed: "Generation failed",
    copied: "Copied",
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
  },
  "zh-CN": {
    title: "Codex 配置",
    description: "multi-provider-gateway / responses",
    refresh: "刷新配置",
    failed: "生成失败",
    copied: "已复制",
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
  },
} as const

async function fetchArtifacts() {
  const response = await fetch("/api/codex/config", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
  const payload = (await response
    .json()
    .catch(() => ({}))) as CodexArtifacts & {
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `HTTP ${response.status}`)
  }
  return payload
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
    await navigator.clipboard.writeText(value)
    setNotice(t.copied)
    window.setTimeout(() => setNotice(""), 1600)
  }

  const environmentLine =
    artifacts?.authRequired && artifacts.envKey
      ? `export ${artifacts.envKey}="<gateway-token>"`
      : ""

  return (
    <section className="flex flex-col gap-6">
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

          <Tabs defaultValue="config">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="config">{t.config}</TabsTrigger>
                <TabsTrigger value="catalog">{t.catalog}</TabsTrigger>
              </TabsList>
              <Badge variant="outline">{artifacts.gatewayUrl}</Badge>
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
                <CardContent>
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
                <CardContent>
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
        </>
      ) : null}
    </section>
  )
}
