import { useState } from "react"
import { FileUpIcon } from "lucide-react"

import type { Locale } from "@/components/language-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { KeyImportResult, ProviderHealth } from "@/gateway-types"
import { cn } from "@/lib/utils"

import { ImportKeysDialog } from "./import-keys-dialog"
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
  const [importOpen, setImportOpen] = useState(false)
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
        <div className="flex flex-wrap items-center justify-end gap-3">
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
              copy.providerSummary(
                provider.keys.length,
                provider.total.requests
              )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <FileUpIcon data-icon="inline-start" />
            {copy.importKeys}
          </Button>
        </div>
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
      {importOpen && (
        <ImportKeysDialog
          providerId={provider.id}
          providerName={provider.name}
          copy={copy}
          open
          onOpenChange={setImportOpen}
          onSuccess={async (result: KeyImportResult) => {
            setFeedback({
              kind: "success",
              message: copy.importSummary(
                result.addedCount,
                result.ignoredCount
              ),
            })
            await onRefresh()
          }}
        />
      )}
    </section>
  )
}
