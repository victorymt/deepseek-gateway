import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckIcon,
  FileCode2Icon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type {
  BalanceQuery,
  BalanceResult,
  Provider,
  ProviderConfig,
} from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

type ModelDraft = { id: string; name: string; upstreamModel: string }
type FetchedModel = ModelDraft & { ownedBy: string | null }
type KeyDraft = {
  name: string
  key: string
  weight: number
  enabled: boolean
  alwaysTry: boolean
  maskedKey?: string
  fingerprint?: string
}
type BalanceQueryDraft = BalanceQuery
type ProviderDraft = {
  id: string
  name: string
  baseUrl: string
  upstreamFormat: "responses" | "chat-completions"
  enabled: boolean
  models: ModelDraft[]
  keys: KeyDraft[]
  balanceQuery: BalanceQueryDraft
}

const DEEPSEEK_BALANCE_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function(response) {
    return (response.balance_infos || []).map(function(info) {
      return {
        planName: String(info.currency || ""),
        remaining: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        unit: String(info.currency || ""),
        isValid: response.is_available !== false
      };
    });
  }
})`

const OPENROUTER_BALANCE_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/key",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function(response) {
    const data = response.data || {};
    const total = data.limit == null ? undefined : Number(data.limit);
    const used = data.usage == null ? undefined : Number(data.usage);
    const remaining = data.limit_remaining == null
      ? (total == null || used == null ? undefined : total - used)
      : Number(data.limit_remaining);
    return {
      planName: data.is_free_tier ? "Free" : "OpenRouter",
      remaining: remaining,
      used: used,
      total: total,
      unit: "USD",
      isValid: Boolean(response.data)
    };
  }
})`

const copy = {
  en: {
    title: "Providers",
    description: "Configuration schema v2",
    setupTitle: "Configure your first provider",
    setupDescription:
      "Gateway setup is waiting for a provider, model, and key.",
    setupAdd: "Add first provider",
    add: "Add provider",
    empty: "No providers configured",
    emptyDescription: "The provider list is empty.",
    enabled: "Enabled",
    disabled: "Disabled",
    default: "Default",
    models: "Models",
    keys: "Keys",
    alias: "Codex alias",
    upstream: "Upstream model",
    weight: "Weight",
    keyEnabled: "Key enabled",
    alwaysTry: "Always try",
    alwaysTryDescription:
      "Keep this key eligible after authentication or upstream failures.",
    fingerprint: "Fingerprint",
    edit: "Edit provider",
    test: "Test connection",
    remove: "Delete provider",
    setDefault: "Set as default",
    setDefaultModel: "Set default model",
    addTitle: "Add provider",
    editTitle: "Edit provider",
    formDescription: "Provider configuration schema v2",
    providerId: "Provider ID",
    providerIdHint: "Lowercase letters, numbers, and hyphens.",
    name: "Display name",
    baseUrl: "Base URL",
    upstreamFormat: "Upstream API format",
    responsesFormat: "Responses",
    chatCompletionsFormat: "Chat Completions",
    modelId: "Model ID",
    modelName: "Model name",
    upstreamModel: "Upstream model",
    keyName: "Key name",
    apiKey: "API key",
    keepKey: "Leave blank to keep the current key.",
    addModel: "Add model",
    fetchModels: "Fetch models",
    modelsFound: (count: number) => `${count} upstream models found`,
    addFetchedModel: "Add",
    modelAdded: "Added",
    noModelsFound: "The upstream returned no models.",
    addKey: "Add key",
    balanceQuery: "Balance query",
    balanceEnabled: "Balance query enabled",
    balanceDisabled: "Balance query disabled",
    balanceCode: "JavaScript",
    balanceTimeout: "Timeout (ms)",
    balanceRefresh: "Refresh override (ms)",
    deepSeekTemplate: "DeepSeek template",
    openRouterTemplate: "OpenRouter template",
    testBalance: "Test balance query",
    balanceTested: (value: string) => `Balance query succeeded · ${value}`,
    cancel: "Cancel",
    save: "Save provider",
    create: "Create provider",
    deleteTitle: "Delete provider?",
    deleteDescription:
      "This removes the provider, its model aliases, and its key pool.",
    delete: "Delete",
    connected: "Connection succeeded",
    failed: "Request failed",
  },
  "zh-CN": {
    title: "Provider 管理",
    description: "配置结构 v2",
    setupTitle: "配置首个 Provider",
    setupDescription: "Gateway 正在等待 Provider、模型和密钥配置。",
    setupAdd: "添加首个 Provider",
    add: "添加 Provider",
    empty: "尚未配置 Provider",
    emptyDescription: "Provider 列表为空。",
    enabled: "已启用",
    disabled: "已停用",
    default: "默认",
    models: "模型",
    keys: "密钥",
    alias: "Codex 别名",
    upstream: "上游模型",
    weight: "权重",
    keyEnabled: "启用密钥",
    alwaysTry: "始终尝试",
    alwaysTryDescription: "鉴权或上游失败后，后续请求仍可继续使用此密钥。",
    fingerprint: "指纹",
    edit: "编辑 Provider",
    test: "测试连接",
    remove: "删除 Provider",
    setDefault: "设为默认",
    setDefaultModel: "设为默认模型",
    addTitle: "添加 Provider",
    editTitle: "编辑 Provider",
    formDescription: "Provider 配置结构 v2",
    providerId: "Provider ID",
    providerIdHint: "仅使用小写字母、数字和连字符。",
    name: "显示名称",
    baseUrl: "Base URL",
    upstreamFormat: "上游 API 格式",
    responsesFormat: "Responses",
    chatCompletionsFormat: "Chat Completions",
    modelId: "模型 ID",
    modelName: "模型名称",
    upstreamModel: "上游模型",
    keyName: "密钥名称",
    apiKey: "API 密钥",
    keepKey: "留空可保留当前密钥。",
    addModel: "添加模型",
    fetchModels: "获取模型",
    modelsFound: (count: number) => `已获取 ${count} 个上游模型`,
    addFetchedModel: "添加",
    modelAdded: "已添加",
    noModelsFound: "上游没有返回模型。",
    addKey: "添加密钥",
    balanceQuery: "额度查询",
    balanceEnabled: "已启用额度查询",
    balanceDisabled: "已停用额度查询",
    balanceCode: "JavaScript",
    balanceTimeout: "超时（毫秒）",
    balanceRefresh: "覆盖刷新周期（毫秒）",
    deepSeekTemplate: "DeepSeek 模板",
    openRouterTemplate: "OpenRouter 模板",
    testBalance: "测试额度查询",
    balanceTested: (value: string) => `额度查询成功 · ${value}`,
    cancel: "取消",
    save: "保存 Provider",
    create: "创建 Provider",
    deleteTitle: "删除 Provider？",
    deleteDescription: "Provider、模型别名及其独立密钥池都会被移除。",
    delete: "删除",
    connected: "连接成功",
    failed: "请求失败",
  },
} as const

const emptyDraft = (): ProviderDraft => ({
  id: "",
  name: "",
  baseUrl: "https://",
  upstreamFormat: "responses",
  enabled: true,
  models: [{ id: "", name: "", upstreamModel: "" }],
  keys: [
    {
      name: "primary",
      key: "",
      weight: 1,
      enabled: true,
      alwaysTry: false,
    },
  ],
  balanceQuery: {
    enabled: false,
    language: "javascript",
    code: "",
    timeoutMs: 10000,
  },
})

function providerDraft(provider: Provider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    upstreamFormat: provider.upstreamFormat,
    enabled: provider.enabled,
    models: provider.models.map(({ id, name, upstreamModel }) => ({
      id,
      name,
      upstreamModel,
    })),
    keys: provider.keys.map((key) => ({
      ...key,
      key: "",
      enabled: key.enabled !== false,
      alwaysTry: key.alwaysTry === true,
    })),
    balanceQuery: provider.balanceQuery ?? {
      enabled: false,
      language: "javascript",
      code: "",
      timeoutMs: 10000,
    },
  }
}

export function ProviderManager({
  locale,
  setupMode = false,
  onConfigured,
}: {
  locale: Locale
  setupMode?: boolean
  onConfigured?: () => Promise<void>
}) {
  const t = copy[locale]
  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [testingId, setTestingId] = useState("")
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchError, setModelFetchError] = useState("")
  const [testingBalance, setTestingBalance] = useState(false)
  const [balanceTestError, setBalanceTestError] = useState("")
  const [balanceTestNotice, setBalanceTestNotice] = useState("")

  const refresh = useCallback(async () => {
    try {
      setConfig(await apiRequest<ProviderConfig>("/api/providers"))
      setError("")
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

  function openCreate() {
    setEditingId(null)
    setDraft(emptyDraft())
    setError("")
    setFetchedModels([])
    setModelFetchError("")
    setBalanceTestError("")
    setBalanceTestNotice("")
    setDialogOpen(true)
  }

  function openEdit(provider: Provider) {
    setEditingId(provider.id)
    setDraft(providerDraft(provider))
    setError("")
    setFetchedModels([])
    setModelFetchError("")
    setBalanceTestError("")
    setBalanceTestNotice("")
    setDialogOpen(true)
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      const payload = {
        ...draft,
        keys: draft.keys.map(({ name, key, weight, enabled, alwaysTry }) => ({
          name,
          key,
          weight,
          enabled,
          alwaysTry,
        })),
      }
      const next = await apiRequest<ProviderConfig>(
        editingId
          ? `/api/providers/${encodeURIComponent(editingId)}`
          : "/api/providers",
        { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }
      )
      setConfig(next)
      setDialogOpen(false)
      if (setupMode && !next.setupPending) await onConfigured?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setSaving(false)
    }
  }

  async function patchProvider(id: string, payload: Record<string, unknown>) {
    setError("")
    setNotice("")
    try {
      const next = await apiRequest<ProviderConfig>(
        `/api/providers/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(payload) }
      )
      setConfig(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    }
  }

  async function deleteProvider(id: string) {
    setError("")
    try {
      const next = await apiRequest<ProviderConfig>(
        `/api/providers/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      )
      setConfig(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    }
  }

  async function testProvider(id: string) {
    setTestingId(id)
    setNotice("")
    setError("")
    try {
      await apiRequest(`/api/providers/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: "{}",
      })
      setNotice(`${t.connected}: ${id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setTestingId("")
    }
  }

  async function fetchModels() {
    setFetchingModels(true)
    setModelFetchError("")
    try {
      const inlineKey = draft.keys.find((key) => key.key.trim())?.key.trim()
      const payload = {
        baseUrl: draft.baseUrl,
        ...(editingId ? { providerId: editingId } : {}),
        ...(inlineKey ? { key: inlineKey } : {}),
      }
      const result = await apiRequest<{ models: FetchedModel[] }>(
        "/api/models",
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      )
      setFetchedModels(result.models)
      if (!result.models.length) setModelFetchError(t.noModelsFound)
    } catch (cause) {
      setFetchedModels([])
      setModelFetchError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setFetchingModels(false)
    }
  }

  async function testBalanceQuery() {
    setTestingBalance(true)
    setBalanceTestError("")
    setBalanceTestNotice("")
    try {
      const selectedKey =
        draft.keys.find((item) => item.key.trim()) ?? draft.keys[0]
      const result = await apiRequest<BalanceResult>("/api/balance/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: draft.baseUrl,
          balanceQuery: draft.balanceQuery,
          ...(editingId ? { providerId: editingId } : {}),
          keyName: selectedKey?.name,
          ...(selectedKey?.key.trim() ? { key: selectedKey.key.trim() } : {}),
        }),
      })
      const first = result.items[0]
      const remaining =
        first?.remaining ??
        (first?.total !== undefined && first?.used !== undefined
          ? first.total - first.used
          : undefined)
      const amount = `${first?.unit ? `${first.unit} ` : ""}${
        remaining === undefined ? "—" : remaining.toLocaleString(locale)
      }`
      setBalanceTestNotice(t.balanceTested(amount))
    } catch (cause) {
      setBalanceTestError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setTestingBalance(false)
    }
  }

  function addFetchedModel(model: FetchedModel) {
    setDraft((value) => {
      if (
        value.models.some((item) => item.upstreamModel === model.upstreamModel)
      ) {
        return value
      }
      const usedIds = new Set(value.models.map((item) => item.id))
      let id = model.id
      let suffix = 2
      while (usedIds.has(id)) {
        const tail = `-${suffix++}`
        id = `${model.id.slice(0, 63 - tail.length)}${tail}`
      }
      const nextModel = {
        id,
        name: model.name,
        upstreamModel: model.upstreamModel,
      }
      const hasOnlyEmptyModel =
        value.models.length === 1 &&
        !value.models[0].id &&
        !value.models[0].name &&
        !value.models[0].upstreamModel
      return {
        ...value,
        models: hasOnlyEmptyModel ? [nextModel] : [...value.models, nextModel],
      }
    })
  }

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
        {config?.providers.map((provider) => {
          const isDefault = config.defaultProvider === provider.id
          return (
            <Card key={provider.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {provider.name}
                  <Badge variant={provider.enabled ? "secondary" : "outline"}>
                    {provider.enabled ? t.enabled : t.disabled}
                  </Badge>
                  <Badge variant="outline">
                    {provider.upstreamFormat === "chat-completions"
                      ? t.chatCompletionsFormat
                      : t.responsesFormat}
                  </Badge>
                  {isDefault && <Badge>{t.default}</Badge>}
                  <Badge
                    variant={provider.balanceQuery?.enabled ? "secondary" : "outline"}
                  >
                    <FileCode2Icon data-icon="inline-start" />
                    {provider.balanceQuery?.enabled
                      ? t.balanceEnabled
                      : t.balanceDisabled}
                  </Badge>
                </CardTitle>
                <CardDescription className="font-mono break-all">
                  {provider.baseUrl}
                </CardDescription>
                <CardAction className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t.test}
                    title={t.test}
                    disabled={testingId === provider.id}
                    onClick={() => void testProvider(provider.id)}
                  >
                    {testingId === provider.id ? <Spinner /> : <PlugZapIcon />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t.edit}
                    title={t.edit}
                    onClick={() => openEdit(provider)}
                  >
                    <PencilIcon />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
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
                          onClick={() => void deleteProvider(provider.id)}
                        >
                          <Trash2Icon data-icon="inline-start" />
                          {t.delete}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <Field
                  orientation="horizontal"
                  data-disabled={isDefault || undefined}
                >
                  <FieldContent>
                    <FieldTitle>{t.enabled}</FieldTitle>
                    <FieldDescription>{provider.id}</FieldDescription>
                  </FieldContent>
                  <Switch
                    checked={provider.enabled}
                    disabled={isDefault}
                    onCheckedChange={(checked) =>
                      void patchProvider(provider.id, { enabled: checked })
                    }
                  />
                </Field>
                {!isDefault && provider.enabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      void patchProvider(provider.id, { makeDefault: true })
                    }
                  >
                    <StarIcon data-icon="inline-start" />
                    {t.setDefault}
                  </Button>
                )}
                <Separator />
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-medium">{t.models}</p>
                  {provider.models.map((model) => (
                    <div
                      key={model.alias}
                      className="flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">{model.name}</p>
                        <p className="font-mono text-xs break-all text-muted-foreground">
                          {model.alias} → {model.upstreamModel}
                        </p>
                      </div>
                      {config.defaultModel === model.alias ? (
                        <Badge variant="outline">{t.default}</Badge>
                      ) : provider.enabled ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t.setDefaultModel}
                          title={t.setDefaultModel}
                          onClick={() =>
                            void patchProvider(provider.id, {
                              makeDefault: true,
                              defaultModel: model.alias,
                            })
                          }
                        >
                          <StarIcon />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Separator />
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-medium">{t.keys}</p>
                  {provider.keys.map((key) => (
                    <div
                      key={key.fingerprint}
                      className="flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-sm">{key.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {key.maskedKey} · {t.fingerprint} {key.fingerprint}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline">
                          {t.weight} {key.weight}
                        </Badge>
                        <Badge variant={key.enabled ? "secondary" : "outline"}>
                          {key.enabled ? t.enabled : t.disabled}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingId ? t.editTitle : t.addTitle}</DialogTitle>
            <DialogDescription>{t.formDescription}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-6" onSubmit={saveProvider}>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="provider-id">{t.providerId}</FieldLabel>
                  <Input
                    id="provider-id"
                    value={draft.id}
                    disabled={Boolean(editingId)}
                    required
                    pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        id: event.target.value,
                      }))
                    }
                  />
                  <FieldDescription>{t.providerIdHint}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="provider-name">{t.name}</FieldLabel>
                  <Input
                    id="provider-name"
                    value={draft.name}
                    required
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        name: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="provider-url">{t.baseUrl}</FieldLabel>
                <Input
                  id="provider-url"
                  type="url"
                  value={draft.baseUrl}
                  required
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      baseUrl: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-upstream-format">
                  {t.upstreamFormat}
                </FieldLabel>
                <Select
                  items={[
                    { value: "responses", label: t.responsesFormat },
                    {
                      value: "chat-completions",
                      label: t.chatCompletionsFormat,
                    },
                  ]}
                  value={draft.upstreamFormat}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      upstreamFormat:
                        value === "chat-completions"
                          ? "chat-completions"
                          : "responses",
                    }))
                  }
                >
                  <SelectTrigger
                    id="provider-upstream-format"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="responses">
                        {t.responsesFormat}
                      </SelectItem>
                      <SelectItem value="chat-completions">
                        {t.chatCompletionsFormat}
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{t.enabled}</FieldTitle>
                </FieldContent>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(checked) =>
                    setDraft((value) => ({ ...value, enabled: checked }))
                  }
                />
              </Field>

              <FieldSet>
                <FieldLegend>{t.balanceQuery}</FieldLegend>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>
                      {draft.balanceQuery.enabled
                        ? t.balanceEnabled
                        : t.balanceDisabled}
                    </FieldTitle>
                  </FieldContent>
                  <Switch
                    checked={draft.balanceQuery.enabled}
                    aria-label={t.balanceQuery}
                    onCheckedChange={(checked) =>
                      setDraft((value) => ({
                        ...value,
                        balanceQuery: {
                          ...value.balanceQuery,
                          enabled: checked,
                        },
                      }))
                    }
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft((value) => ({
                        ...value,
                        balanceQuery: {
                          ...value.balanceQuery,
                          enabled: true,
                          code: DEEPSEEK_BALANCE_SCRIPT,
                        },
                      }))
                    }
                  >
                    <FileCode2Icon data-icon="inline-start" />
                    {t.deepSeekTemplate}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft((value) => ({
                        ...value,
                        balanceQuery: {
                          ...value.balanceQuery,
                          enabled: true,
                          code: OPENROUTER_BALANCE_SCRIPT,
                        },
                      }))
                    }
                  >
                    <FileCode2Icon data-icon="inline-start" />
                    {t.openRouterTemplate}
                  </Button>
                </div>
                {draft.balanceQuery.enabled && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="balance-timeout">
                          {t.balanceTimeout}
                        </FieldLabel>
                        <Input
                          id="balance-timeout"
                          type="number"
                          min="2000"
                          max="30000"
                          step="1000"
                          value={draft.balanceQuery.timeoutMs}
                          required
                          onChange={(event) =>
                            setDraft((value) => ({
                              ...value,
                              balanceQuery: {
                                ...value.balanceQuery,
                                timeoutMs: Number(event.target.value),
                              },
                            }))
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="balance-refresh">
                          {t.balanceRefresh}
                        </FieldLabel>
                        <Input
                          id="balance-refresh"
                          type="number"
                          min="10000"
                          max="86400000"
                          step="1000"
                          value={draft.balanceQuery.refreshMs ?? ""}
                          onChange={(event) =>
                            setDraft((value) => {
                              const refreshMs = event.target.value
                                ? Number(event.target.value)
                                : undefined
                              const nextQuery = {
                                ...value.balanceQuery,
                                refreshMs,
                              }
                              if (refreshMs === undefined) {
                                delete nextQuery.refreshMs
                              }
                              return { ...value, balanceQuery: nextQuery }
                            })
                          }
                        />
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="balance-script">
                        {t.balanceCode}
                      </FieldLabel>
                      <Textarea
                        id="balance-script"
                        className="min-h-72 resize-y font-mono text-xs"
                        value={draft.balanceQuery.code}
                        required
                        spellCheck={false}
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            balanceQuery: {
                              ...value.balanceQuery,
                              code: event.target.value,
                            },
                          }))
                        }
                      />
                    </Field>
                    {balanceTestError && (
                      <Alert variant="destructive">
                        <AlertTitle>{t.failed}</AlertTitle>
                        <AlertDescription>{balanceTestError}</AlertDescription>
                      </Alert>
                    )}
                    {balanceTestNotice && (
                      <Alert>
                        <CheckIcon />
                        <AlertTitle>{balanceTestNotice}</AlertTitle>
                      </Alert>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start"
                      disabled={
                        testingBalance ||
                        !draft.balanceQuery.code.trim() ||
                        (!editingId &&
                          !draft.keys.some((item) => item.key.trim()))
                      }
                      onClick={() => void testBalanceQuery()}
                    >
                      {testingBalance ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      {t.testBalance}
                    </Button>
                  </>
                )}
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t.models}</FieldLegend>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={fetchingModels || !draft.baseUrl.trim()}
                    onClick={() => void fetchModels()}
                  >
                    {fetchingModels ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    {t.fetchModels}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft((value) => ({
                        ...value,
                        models: [
                          ...value.models,
                          { id: "", name: "", upstreamModel: "" },
                        ],
                      }))
                    }
                  >
                    <PlusIcon data-icon="inline-start" />
                    {t.addModel}
                  </Button>
                </div>
                {modelFetchError && (
                  <p className="text-sm text-destructive" role="alert">
                    {modelFetchError}
                  </p>
                )}
                {fetchedModels.length > 0 && (
                  <div className="overflow-hidden rounded-md border bg-muted/20">
                    <div className="border-b px-3 py-2 text-sm font-medium">
                      {t.modelsFound(fetchedModels.length)}
                    </div>
                    <div className="max-h-52 divide-y overflow-y-auto">
                      {fetchedModels.map((model) => {
                        const added = draft.models.some(
                          (item) => item.upstreamModel === model.upstreamModel
                        )
                        return (
                          <div
                            key={model.upstreamModel}
                            className="flex items-center justify-between gap-3 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-sm">
                                {model.upstreamModel}
                              </p>
                              {model.ownedBy && (
                                <p className="text-xs text-muted-foreground">
                                  {model.ownedBy}
                                </p>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={added}
                              onClick={() => addFetchedModel(model)}
                            >
                              {added ? (
                                <CheckIcon data-icon="inline-start" />
                              ) : (
                                <PlusIcon data-icon="inline-start" />
                              )}
                              {added ? t.modelAdded : t.addFetchedModel}
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {draft.models.map((model, index) => (
                  <div
                    key={`model-${index}`}
                    className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto]"
                  >
                    <Field>
                      <FieldLabel htmlFor={`model-id-${index}`}>
                        {t.modelId}
                      </FieldLabel>
                      <Input
                        id={`model-id-${index}`}
                        value={model.id}
                        required
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            models: value.models.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, id: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`model-name-${index}`}>
                        {t.modelName}
                      </FieldLabel>
                      <Input
                        id={`model-name-${index}`}
                        value={model.name}
                        required
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            models: value.models.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, name: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`upstream-model-${index}`}>
                        {t.upstreamModel}
                      </FieldLabel>
                      <Input
                        id={`upstream-model-${index}`}
                        value={model.upstreamModel}
                        required
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            models: value.models.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, upstreamModel: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t.remove}
                      title={t.remove}
                      disabled={draft.models.length === 1}
                      onClick={() =>
                        setDraft((value) => ({
                          ...value,
                          models: value.models.filter(
                            (_, itemIndex) => itemIndex !== index
                          ),
                        }))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t.keys}</FieldLegend>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-end"
                  onClick={() =>
                    setDraft((value) => ({
                      ...value,
                      keys: [
                        ...value.keys,
                        {
                          name: `key-${value.keys.length + 1}`,
                          key: "",
                          weight: 1,
                          enabled: true,
                          alwaysTry: false,
                        },
                      ],
                    }))
                  }
                >
                  <PlusIcon data-icon="inline-start" />
                  {t.addKey}
                </Button>
                {draft.keys.map((key, index) => (
                  <div
                    key={`key-${index}`}
                    className="grid items-start gap-3 sm:grid-cols-[1fr_1.4fr_7rem_7rem_auto]"
                  >
                    <Field>
                      <FieldLabel htmlFor={`key-name-${index}`}>
                        {t.keyName}
                      </FieldLabel>
                      <Input
                        id={`key-name-${index}`}
                        value={key.name}
                        required
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            keys: value.keys.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, name: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`key-secret-${index}`}>
                        {t.apiKey}
                      </FieldLabel>
                      <Input
                        id={`key-secret-${index}`}
                        type="password"
                        value={key.key}
                        required={!editingId || !key.maskedKey}
                        placeholder={key.maskedKey || "sk-..."}
                        autoComplete="new-password"
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            keys: value.keys.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, key: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                      {key.maskedKey && (
                        <FieldDescription>{t.keepKey}</FieldDescription>
                      )}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`key-weight-${index}`}>
                        {t.weight}
                      </FieldLabel>
                      <Input
                        id={`key-weight-${index}`}
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={key.weight}
                        required
                        onChange={(event) =>
                          setDraft((value) => ({
                            ...value,
                            keys: value.keys.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    weight: Number(event.target.value),
                                  }
                                : item
                            ),
                          }))
                        }
                      />
                    </Field>
                    <div className="flex flex-col gap-3">
                      <Field
                        data-disabled={
                          key.enabled &&
                          draft.keys.filter((item) => item.enabled).length === 1
                            ? true
                            : undefined
                        }
                      >
                        <FieldLabel htmlFor={`key-enabled-${index}`}>
                          {t.keyEnabled}
                        </FieldLabel>
                        <Switch
                          id={`key-enabled-${index}`}
                          checked={key.enabled}
                          disabled={
                            key.enabled &&
                            draft.keys.filter((item) => item.enabled).length ===
                              1
                          }
                          onCheckedChange={(checked) =>
                            setDraft((value) => ({
                              ...value,
                              keys: value.keys.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, enabled: checked }
                                  : item
                              ),
                            }))
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`key-always-try-${index}`}>
                          {t.alwaysTry}
                        </FieldLabel>
                        <Switch
                          id={`key-always-try-${index}`}
                          checked={key.alwaysTry}
                          title={t.alwaysTryDescription}
                          onCheckedChange={(checked) =>
                            setDraft((value) => ({
                              ...value,
                              keys: value.keys.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, alwaysTry: checked }
                                  : item
                              ),
                            }))
                          }
                        />
                      </Field>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="self-end"
                      aria-label={t.remove}
                      title={t.remove}
                      disabled={
                        draft.keys.length === 1 ||
                        (key.enabled &&
                          draft.keys.filter((item) => item.enabled).length ===
                            1)
                      }
                      onClick={() =>
                        setDraft((value) => ({
                          ...value,
                          keys: value.keys.filter(
                            (_, itemIndex) => itemIndex !== index
                          ),
                        }))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </FieldSet>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                {t.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner data-icon="inline-start" />}
                {editingId ? t.save : t.create}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
