import { useCallback } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { ProviderConfig } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { useOperationsPage } from "./page-state"
import { OperationsPageShell } from "./page-shell"
import type { OperationsPageProps } from "./types"

export default function ModelsPage({
  locale,
  health,
  active,
}: OperationsPageProps) {
  const load = useCallback(
    (signal: AbortSignal) =>
      apiRequest<ProviderConfig>("/api/providers", { signal }),
    []
  )
  const page = useOperationsPage(load, active, null)
  const providerConfig = page.data
  const models =
    providerConfig?.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.name,
        providerId: provider.id,
        model: model.alias,
        name: model.name,
        upstream: model.upstreamModel,
        inputModalities: model.inputModalities || [],
        reasoning: model.reasoning,
        supportsHostedWebSearch: model.supportsHostedWebSearch === true,
        supportsCustomApplyPatch: model.supportsCustomApplyPatch === true,
        requests:
          health?.providers.find((item) => item.id === provider.id)?.total
            .requests || 0,
        tokens:
          health?.providers.find((item) => item.id === provider.id)?.total
            .tokens || 0,
      }))
    ) || []
  const zh = locale === "zh-CN"

  return (
    <OperationsPageShell
      kind="models"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
    >
      <div className="operation-grid">
        {models.map((item) => (
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
              <div className="operation-row wrap">
                <Badge variant="outline">
                  {item.inputModalities.includes("image")
                    ? zh
                      ? "图像输入"
                      : "Image input"
                    : zh
                      ? "仅文本"
                      : "Text only"}
                </Badge>
                {item.reasoning && item.reasoning.levels?.length > 0 && (
                  <Badge variant="outline">
                    {zh ? "思考" : "Reasoning"} · {item.reasoning.levels.length}{" "}
                    {zh ? "级" : "levels"}
                  </Badge>
                )}
                {item.supportsHostedWebSearch && (
                  <Badge variant="outline">
                    {zh ? "托管搜索" : "Web search"}
                  </Badge>
                )}
                {item.supportsCustomApplyPatch && (
                  <Badge variant="outline">apply_patch</Badge>
                )}
              </div>
              <Badge variant="outline">
                {item.model === health?.defaultModel
                  ? zh
                    ? "默认"
                    : "Default"
                  : zh
                    ? "可用"
                    : "Available"}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      {!page.loading && !models.length && (
        <p className="empty-copy">
          {zh ? "暂无模型" : "No models configured"}
        </p>
      )}
    </OperationsPageShell>
  )
}
