import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckIcon,
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
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { Provider, ProviderConfig } from "@/gateway-types"

type ModelDraft = { id: string; name: string; upstreamModel: string }
type FetchedModel = ModelDraft & { ownedBy: string | null }
type KeyDraft = {
  name: string
  key: string
  weight: number
  enabled: boolean
  maskedKey?: string
  fingerprint?: string
}
type ProviderDraft = {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  models: ModelDraft[]
  keys: KeyDraft[]
}

const copy = {
  en: {
    title: "Providers",
    description: "Configuration schema v2",
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
  enabled: true,
  models: [{ id: "", name: "", upstreamModel: "" }],
  keys: [{ name: "primary", key: "", weight: 1, enabled: true }],
})

function providerDraft(provider: Provider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
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
    })),
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `HTTP ${response.status}`)
  }
  return payload as T
}

export function ProviderManager({ locale }: { locale: Locale }) {
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

  const refresh = useCallback(async () => {
    try {
      setConfig(await api<ProviderConfig>("/api/providers"))
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
    setDialogOpen(true)
  }

  function openEdit(provider: Provider) {
    setEditingId(provider.id)
    setDraft(providerDraft(provider))
    setError("")
    setFetchedModels([])
    setModelFetchError("")
    setDialogOpen(true)
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      const payload = {
        ...draft,
        keys: draft.keys.map(({ name, key, weight, enabled }) => ({
          name,
          key,
          weight,
          enabled,
        })),
      }
      const next = await api<ProviderConfig>(
        editingId
          ? `/api/providers/${encodeURIComponent(editingId)}`
          : "/api/providers",
        { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }
      )
      setConfig(next)
      setDialogOpen(false)
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
      const next = await api<ProviderConfig>(
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
      const next = await api<ProviderConfig>(
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
      await api(`/api/providers/${encodeURIComponent(id)}/test`, {
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
      const result = await api<{ models: FetchedModel[] }>("/api/models", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      setFetchedModels(result.models)
      if (!result.models.length) setModelFetchError(t.noModelsFound)
    } catch (cause) {
      setFetchedModels([])
      setModelFetchError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setFetchingModels(false)
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
          <h2 className="text-xl font-semibold">{t.title}</h2>
          <p className="text-sm text-muted-foreground">{t.description}</p>
        </div>
        <Button onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          {t.add}
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
                  {isDefault && <Badge>{t.default}</Badge>}
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
                          draft.keys.filter((item) => item.enabled).length === 1
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
