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
        requests:
          health?.providers.find((item) => item.id === provider.id)?.total
            .requests || 0,
        tokens:
          health?.providers.find((item) => item.id === provider.id)?.total
            .tokens || 0,
      }))
    ) || []

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
              <Badge variant="outline">
                {item.model === health?.defaultModel ? "Default" : "Available"}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
      {!page.loading && !models.length && (
        <p className="empty-copy">
          {locale === "zh-CN" ? "暂无模型" : "No models configured"}
        </p>
      )}
    </OperationsPageShell>
  )
}
