import { CheckIcon, PlusIcon, ServerIcon } from "lucide-react"

import type { Locale } from "@/components/language-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { providerCopy } from "@/features/providers/provider-copy"
import { ProviderCard } from "@/features/providers/provider-card"
import { ProviderEditorDialog } from "@/features/providers/provider-editor-dialog"
import { useProviderManager } from "@/features/providers/use-provider-manager"

export function ProviderManager({
  locale,
  setupMode = false,
  onConfigured,
}: {
  locale: Locale
  setupMode?: boolean
  onConfigured?: () => Promise<void>
}) {
  const t = providerCopy[locale]
  const {
    addFetchedModel,
    balanceTestError,
    balanceTestNotice,
    config,
    deleteProvider,
    dialogError,
    dialogOpen,
    draft,
    editingId,
    error,
    fetchedModels,
    fetchingModels,
    fetchModels,
    loading,
    modelFetchError,
    notice,
    openCreate,
    openEdit,
    patchProvider,
    saveProvider,
    saving,
    setDialogOpen,
    setDraft,
    testBalanceQuery,
    testingBalance,
    testingId,
    testProvider,
  } = useProviderManager({
    locale,
    messages: t,
    setupMode,
    onConfigured,
  })

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">
            {setupMode ? t.setupTitle : t.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {setupMode ? t.setupDescription : t.description}
          </p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          {setupMode ? t.setupAdd : t.add}
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

      {loading && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      )}

      {!loading && !config?.providers.length && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>{t.empty}</EmptyTitle>
            <EmptyDescription>{t.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {config?.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            defaultProvider={config.defaultProvider}
            defaultModel={config.defaultModel}
            testing={testingId === provider.id}
            copy={t}
            onDelete={deleteProvider}
            onEdit={openEdit}
            onPatch={patchProvider}
            onTest={testProvider}
          />
        ))}
      </div>

      <ProviderEditorDialog
        open={dialogOpen}
        copy={t}
        draft={draft}
        editingId={editingId}
        saving={saving}
        error={dialogError}
        balanceTestError={balanceTestError}
        balanceTestNotice={balanceTestNotice}
        testingBalance={testingBalance}
        fetchedModels={fetchedModels}
        fetchingModels={fetchingModels}
        modelFetchError={modelFetchError}
        setDraft={setDraft}
        onAddFetchedModel={addFetchedModel}
        onFetchModels={fetchModels}
        onOpenChange={setDialogOpen}
        onSubmit={saveProvider}
        onTestBalance={testBalanceQuery}
      />
    </section>
  )
}
