import { useCallback, useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ProviderKeySection } from "@/features/provider-keys/provider-key-section"
import type { ProviderKeyCopy } from "@/features/provider-keys/types"
import { providerCopy } from "@/features/providers/provider-copy"
import { ProviderEditorDialog } from "@/features/providers/provider-editor-dialog"
import { ProviderDiscardDialog } from "@/features/providers/provider-discard-dialog"
import { useProviderManager } from "@/features/providers/use-provider-manager"
import type { Health } from "@/gateway-types"
import { formatNumber } from "@/lib/format-number"
import { notifyConfigChanged } from "@/lib/setup-actions"

type DetailTab = "overview" | "models" | "usage" | "keys" | "settings"

const EMPTY_TOTAL = {
  requests: 0,
  success: 0,
  errors: 0,
  ratelimited: 0,
  tokens: 0,
}

export function ProviderWorkspace({
  health,
  locale,
  onRefresh,
  keyCopy,
  onDirtyChange,
}: {
  health: Health | null
  locale: Locale
  onRefresh: () => Promise<void>
  keyCopy: ProviderKeyCopy
  onDirtyChange?: (dirty: boolean) => void
}) {
  const t = providerCopy[locale]
  const [query, setQuery] = useState("")
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>("overview")
  const [detailVisible, setDetailVisible] = useState(false)
  const [selectedId, setSelectedId] = useState(health?.defaultProvider || "")
  const [dirtySources, setDirtySources] = useState<Record<string, boolean>>({})
  const reportWorkspaceDirty = useCallback((source: string, dirty: boolean) => {
    setDirtySources((current) => {
      if (current[source] === dirty) return current
      return { ...current, [source]: dirty }
    })
  }, [])
  const reportEditorDirty = useCallback(
    (dirty: boolean) => reportWorkspaceDirty("provider-editor", dirty),
    [reportWorkspaceDirty]
  )

  useEffect(() => {
    onDirtyChange?.(Object.values(dirtySources).some(Boolean))
    return () => onDirtyChange?.(false)
  }, [dirtySources, onDirtyChange])

  const manager = useProviderManager({
    locale,
    messages: t,
    setupMode: false,
    onChanged: async () => {
      notifyConfigChanged()
      await onRefresh()
    },
    onDirtyChange: reportEditorDirty,
  })

  const providers = manager.config?.providers
  const selected =
    providers?.find((provider) => provider.id === selectedId) ??
    providers?.find((provider) => provider.id === health?.defaultProvider) ??
    providers?.[0]
  const runtime = health?.providers.find(
    (provider) => provider.id === selected?.id
  )
  const totals = runtime?.total ?? EMPTY_TOTAL
  const connection = selected
    ? manager.connectionResults[selected.id]
    : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleProviders = (providers ?? []).filter(
    (provider) =>
      (!enabledOnly || provider.enabled) &&
      (!normalizedQuery ||
        provider.name.toLocaleLowerCase().includes(normalizedQuery) ||
        provider.id.toLocaleLowerCase().includes(normalizedQuery))
  )

  function connectionLabel(providerId: string) {
    const result = manager.connectionResults[providerId]
    if (!result) return locale === "zh-CN" ? "未检测" : "Not tested"
    return result.state === "available"
      ? locale === "zh-CN"
        ? "可用"
        : "Available"
      : locale === "zh-CN"
        ? "失败"
        : "Failed"
  }

  async function refreshKeys() {
    if (selected) manager.clearConnectionResult(selected.id)
    await Promise.all([manager.refresh(), onRefresh()])
  }

  return (
    <div className="provider-workspace">
      <div className="provider-list-pane">
        <div className="workspace-heading">
          <h1>{locale === "zh-CN" ? "Provider" : "Providers"}</h1>
          <span className="provider-count">{providers?.length ?? 0}</span>
        </div>
        <div className="provider-search-row">
          <label className="provider-search">
            <SearchIcon size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                locale === "zh-CN" ? "搜索 Provider..." : "Search providers..."
              }
            />
          </label>
          <button
            className={`filter-button ${enabledOnly ? "active" : ""}`}
            aria-label={
              locale === "zh-CN" ? "仅显示已启用" : "Show enabled only"
            }
            aria-pressed={enabledOnly}
            onClick={() => setEnabledOnly((value) => !value)}
          >
            <SlidersHorizontalIcon size={18} />
          </button>
        </div>
        <div className="provider-group-label">
          {locale === "zh-CN" ? "已配置" : "CONFIGURED"}
          <span>{visibleProviders.length}</span>
        </div>
        <div className="provider-list">
          {manager.loading && !providers?.length ? (
            <div className="provider-list-loading">
              {locale === "zh-CN" ? "正在加载..." : "Loading..."}
            </div>
          ) : (
            visibleProviders.map((provider) => {
              const result = manager.connectionResults[provider.id]
              return (
                <button
                  key={provider.id}
                  className={`provider-list-item ${provider.id === selected?.id ? "selected" : ""}`}
                  aria-pressed={provider.id === selected?.id}
                  onClick={() => {
                    setSelectedId(provider.id)
                    setDetailVisible(true)
                  }}
                >
                  <span className="provider-avatar">
                    {provider.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="provider-list-copy">
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.models.length}{" "}
                      {locale === "zh-CN"
                        ? "个模型"
                        : provider.models.length === 1
                          ? "model"
                          : "models"}
                    </small>
                  </span>
                  {provider.id === manager.config?.defaultProvider && (
                    <StarIcon
                      className="provider-star"
                      aria-label={t.default}
                    />
                  )}
                  <span
                    className={`status-dot ${result?.state === "available" ? "online" : result?.state === "failed" ? "failed" : "offline"}`}
                    aria-label={connectionLabel(provider.id)}
                    title={connectionLabel(provider.id)}
                  />
                </button>
              )
            })
          )}
        </div>
      </div>

      <div
        className={`provider-detail-pane ${detailVisible ? "mobile-visible" : ""}`}
      >
        <div className="detail-topbar">
          <button
            className="back-button"
            aria-label={
              locale === "zh-CN" ? "返回 Provider 列表" : "Back to providers"
            }
            onClick={() => setDetailVisible(false)}
          >
            <ArrowLeftIcon />
          </button>
          <h2>
            {locale === "zh-CN" ? "Provider 配置" : "Provider configuration"}
          </h2>
          <Button className="add-provider-button" onClick={manager.openCreate}>
            <PlusIcon data-icon="inline-start" />
            {t.add}
          </Button>
        </div>

        {manager.error && (
          <Alert variant="destructive" className="mb-3">
            <AlertTitle>{t.failed}</AlertTitle>
            <AlertDescription>{manager.error}</AlertDescription>
          </Alert>
        )}

        {selected ? (
          <>
            <div className="provider-identity">
              <span className="provider-logo large">
                {selected.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <h3>{selected.name}</h3>
                <p className="provider-id-line">{selected.id}</p>
              </div>
              <div className="detail-actions">
                {selected.id !== manager.config?.defaultProvider &&
                  selected.enabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void manager.patchProvider(selected.id, {
                          makeDefault: true,
                        })
                      }
                    >
                      <StarIcon data-icon="inline-start" />
                      {t.setDefault}
                    </Button>
                  )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={manager.testingId === selected.id}
                  onClick={() => void manager.testProvider(selected.id)}
                >
                  {manager.testingId === selected.id ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlugZapIcon data-icon="inline-start" />
                  )}
                  {t.test}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => manager.openEdit(selected)}
                >
                  <PencilIcon data-icon="inline-start" />
                  {t.edit}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        className="provider-delete-button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={t.remove}
                        title={t.remove}
                      />
                    }
                  >
                    <Trash2Icon />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t.deleteDescription}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => void manager.deleteProvider(selected.id)}
                      >
                        {t.delete}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <label className="enabled-control">
                  <span className="enabled-label">
                    {selected.enabled ? t.enabled : t.disabled}
                  </span>
                  <Switch
                    checked={selected.enabled}
                    aria-label={`${selected.name} ${t.enabled}`}
                    disabled={selected.id === manager.config?.defaultProvider}
                    onCheckedChange={(enabled) =>
                      void manager.patchProvider(selected.id, { enabled })
                    }
                  />
                </label>
              </div>
            </div>

            <nav className="detail-tabs">
              {(
                [
                  ["overview", locale === "zh-CN" ? "概览" : "Overview"],
                  ["models", t.models],
                  ["usage", locale === "zh-CN" ? "用量" : "Usage"],
                  ["keys", locale === "zh-CN" ? "API 密钥" : "API keys"],
                  ["settings", locale === "zh-CN" ? "设置" : "Settings"],
                ] as Array<[DetailTab, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  className={detailTab === id ? "active" : ""}
                  onClick={() => setDetailTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>

            {detailTab === "overview" ? (
              <div className="detail-grid">
                <section className="detail-section">
                  <h4>{locale === "zh-CN" ? "连接" : "Connection"}</h4>
                  <dl>
                    <div>
                      <dt>{locale === "zh-CN" ? "配置" : "Configuration"}</dt>
                      <dd>{selected.enabled ? t.enabled : t.disabled}</dd>
                    </div>
                    <div>
                      <dt>{locale === "zh-CN" ? "检测结果" : "Test result"}</dt>
                      <dd
                        className={
                          connection?.state === "available"
                            ? "success-text"
                            : connection?.state === "failed"
                              ? "error-text"
                              : ""
                        }
                      >
                        {connectionLabel(selected.id)}
                      </dd>
                    </div>
                    {connection?.status !== undefined && (
                      <div>
                        <dt>HTTP</dt>
                        <dd>
                          {connection.status} · {connection.latencyMs} ms
                        </dd>
                      </div>
                    )}
                    {connection?.message && (
                      <div>
                        <dt>{locale === "zh-CN" ? "错误" : "Error"}</dt>
                        <dd className="error-text">{connection.message}</dd>
                      </div>
                    )}
                    {connection && (
                      <div>
                        <dt>{locale === "zh-CN" ? "检测时间" : "Tested"}</dt>
                        <dd>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "short",
                            timeStyle: "medium",
                          }).format(connection.testedAt)}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>{t.baseUrl}</dt>
                      <dd className="mono">{selected.baseUrl}</dd>
                    </div>
                  </dl>
                </section>
                <section className="detail-section">
                  <h4>{locale === "zh-CN" ? "运行统计" : "Runtime totals"}</h4>
                  <dl>
                    <div>
                      <dt>{locale === "zh-CN" ? "请求" : "Requests"}</dt>
                      <dd>{formatNumber(totals.requests, locale)}</dd>
                    </div>
                    <div>
                      <dt>{locale === "zh-CN" ? "成功" : "Success"}</dt>
                      <dd>{formatNumber(totals.success, locale)}</dd>
                    </div>
                    <div>
                      <dt>{locale === "zh-CN" ? "错误" : "Errors"}</dt>
                      <dd>{formatNumber(totals.errors, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t.tokens}</dt>
                      <dd>{formatNumber(totals.tokens, locale)}</dd>
                    </div>
                  </dl>
                </section>
                <section className="detail-section speed-section">
                  <h4>
                    {locale === "zh-CN" ? "可用资源" : "Available resources"}
                  </h4>
                  <dl>
                    <div>
                      <dt>{t.models}</dt>
                      <dd>{selected.models.length}</dd>
                    </div>
                    <div>
                      <dt>{t.apiKeys}</dt>
                      <dd>{selected.keys.length}</dd>
                    </div>
                    <div>
                      <dt>
                        {locale === "zh-CN" ? "默认模型" : "Default model"}
                      </dt>
                      <dd>{manager.config?.defaultModel || "-"}</dd>
                    </div>
                  </dl>
                </section>
              </div>
            ) : detailTab === "models" ? (
              <section className="provider-model-list">
                {selected.models.map((model) => (
                  <div key={model.alias}>
                    <span>
                      <strong>{model.name}</strong>
                      <small>
                        {model.alias} → {model.upstreamModel}
                      </small>
                    </span>
                    {manager.config?.defaultModel === model.alias ? (
                      <Badge>{t.default}</Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void manager.patchProvider(selected.id, {
                            makeDefault: true,
                            defaultModel: model.alias,
                          })
                        }
                      >
                        {t.setDefaultModel}
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            ) : detailTab === "keys" ? (
              runtime ? (
                <div className="provider-keys-tab">
                  <ProviderKeySection
                    provider={runtime}
                    locale={locale}
                    copy={keyCopy}
                    onRefresh={refreshKeys}
                    onDirtyChange={reportWorkspaceDirty}
                  />
                </div>
              ) : (
                <EmptyRuntime locale={locale} />
              )
            ) : detailTab === "usage" ? (
              <section className="detail-summary-tab">
                <h4>{locale === "zh-CN" ? "运行时用量" : "Runtime usage"}</h4>
                <div className="detail-summary-grid">
                  {Object.entries(totals).map(([label, value]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{formatNumber(value, locale)}</strong>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section className="detail-settings-tab detail-section">
                <h4>
                  {locale === "zh-CN" ? "Provider 设置" : "Provider settings"}
                </h4>
                <dl>
                  <div>
                    <dt>{t.apiProfile}</dt>
                    <dd>{selected.apiProfile}</dd>
                  </div>
                  <div>
                    <dt>{t.upstreamFormat}</dt>
                    <dd>{selected.upstreamFormat}</dd>
                  </div>
                  <div>
                    <dt>{t.balanceQuery}</dt>
                    <dd>
                      {selected.balanceQuery?.enabled ? t.enabled : t.disabled}
                    </dd>
                  </div>
                </dl>
                <Button
                  variant="outline"
                  onClick={() => manager.openEdit(selected)}
                >
                  <PencilIcon data-icon="inline-start" />
                  {t.edit}
                </Button>
              </section>
            )}
          </>
        ) : (
          <div className="empty-provider-detail">
            <div className="flex flex-col items-center gap-4">
              <span>{t.empty}</span>
              <Button onClick={manager.openCreate}>
                <PlusIcon data-icon="inline-start" />
                {t.add}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ProviderEditorDialog
        open={manager.dialogOpen}
        copy={t}
        draft={manager.draft}
        editingId={manager.editingId}
        originalBaseUrl={manager.originalBaseUrl}
        saving={manager.saving}
        error={manager.dialogError}
        balanceTestError={manager.balanceTestError}
        balanceTestNotice={manager.balanceTestNotice}
        testingBalance={manager.testingBalance}
        fetchedModels={manager.fetchedModels}
        fetchingModels={manager.fetchingModels}
        modelFetchError={manager.modelFetchError}
        modelCapabilities={manager.modelCapabilities}
        setDraft={manager.setDraft}
        onAddFetchedModel={manager.addFetchedModel}
        onFetchModels={manager.fetchModels}
        onOpenChange={manager.setDialogOpen}
        onSubmit={manager.saveProvider}
        onTestBalance={manager.testBalanceQuery}
      />
      <ProviderDiscardDialog
        open={manager.discardDialogOpen}
        title={t.discardChanges}
        cancel={t.cancel}
        discard={t.discard}
        onOpenChange={manager.setDiscardDialogOpen}
        onDiscard={manager.discardDialogChanges}
      />
    </div>
  )
}

function EmptyRuntime({ locale }: { locale: Locale }) {
  return (
    <div className="empty-provider-detail">
      {locale === "zh-CN"
        ? "等待运行时密钥数据"
        : "Waiting for runtime key data"}
    </div>
  )
}
