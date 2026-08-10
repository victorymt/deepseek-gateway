import { useState } from "react"

import type { Locale } from "@/components/language-provider"
import { Badge } from "@/components/ui/badge"
import type { ProviderHealth } from "@/gateway-types"
import { cn } from "@/lib/utils"

import { KeyCard } from "./key-card"
import type { KeyFeedback, ProviderKeyCopy } from "./types"

export function ProviderKeySection({
  provider,
  locale,
  copy,
  onRefresh,
}: {
  provider: ProviderHealth
  locale: Locale
  copy: ProviderKeyCopy
  onRefresh: () => Promise<void>
}) {
  const [feedback, setFeedback] = useState<KeyFeedback>(null)
  const enabledKeyCount = provider.keys.filter(
    (keyInfo) => keyInfo.enabled !== false
  ).length

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby={`provider-${provider.id}`}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={`provider-${provider.id}`}
              className="text-lg font-semibold"
            >
              {provider.name}
            </h3>
            <Badge variant={provider.enabled ? "secondary" : "outline"}>
              {provider.enabled ? copy.enabledProvider : copy.disabledProvider}
            </Badge>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.id} · {provider.baseUrl}
          </p>
        </div>
        <p
          className={cn(
            "max-w-full min-w-0 truncate font-mono text-xs sm:text-right",
            feedback?.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
          aria-live="polite"
        >
          {feedback?.message ??
            copy.providerSummary(provider.keys.length, provider.total.requests)}
        </p>
      </header>
      <div className="grid items-stretch gap-3 md:grid-cols-2">
        {provider.keys.map((keyInfo) => (
          <KeyCard
            key={`${provider.id}:${keyInfo.name}`}
            providerId={provider.id}
            keyInfo={keyInfo}
            balanceQueryEnabled={provider.balanceQueryEnabled}
            locale={locale}
            copy={copy}
            cannotDisable={keyInfo.enabled !== false && enabledKeyCount === 1}
            cannotDelete={
              provider.keys.length === 1 ||
              (keyInfo.enabled !== false && enabledKeyCount === 1)
            }
            onRefresh={onRefresh}
            onFeedback={setFeedback}
          />
        ))}
      </div>
    </section>
  )
}
