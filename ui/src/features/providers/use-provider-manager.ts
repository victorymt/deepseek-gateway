import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import type { Locale } from "@/components/language-provider"
import type {
  BalanceResult,
  ModelCapabilityCatalog,
  Provider,
  ProviderConfig,
} from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import {
  addFetchedModelToDraft,
  balanceResultAmount,
  createEmptyProviderDraft,
  providerDraftPayload,
  providerToDraft,
  providerUpdatePayload,
  type FetchedModel,
  type ProviderDraft,
} from "./provider-editor-state"

type ProviderManagerMessages = {
  failed: string
  connected: string
  noModelsFound: string
  discardChanges: string
  concurrentChange: string
  reenterKeysForOrigin: string
  balanceTested: (value: string) => string
}

type UseProviderManagerOptions = {
  locale: Locale
  messages: ProviderManagerMessages
  setupMode: boolean
  onConfigured?: () => Promise<void>
  onChanged?: () => Promise<void> | void
  onDirtyChange?: (dirty: boolean) => void
}

export type ProviderConnectionResult = {
  state: "available" | "failed"
  testedAt: number
  status?: number
  latencyMs?: number
  message?: string
}

const CONNECTION_RESULTS_KEY = "deepseek-gateway.provider-connection-results"

function storedConnectionResults(): Record<string, ProviderConnectionResult> {
  try {
    return JSON.parse(
      window.sessionStorage.getItem(CONNECTION_RESULTS_KEY) || "{}"
    )
  } catch {
    return {}
  }
}

function storeConnectionResults(
  results: Record<string, ProviderConnectionResult>
) {
  try {
    window.sessionStorage.setItem(
      CONNECTION_RESULTS_KEY,
      JSON.stringify(results)
    )
  } catch {
    // Connection tests still remain visible until this page is reloaded.
  }
  return results
}

function withoutConnectionResult(
  results: Record<string, ProviderConnectionResult>,
  providerId: string
) {
  const nextResults = { ...results }
  delete nextResults[providerId]
  return storeConnectionResults(nextResults)
}

export function useProviderManager({
  locale,
  messages,
  setupMode,
  onConfigured,
  onChanged,
  onDirtyChange,
}: UseProviderManagerOptions) {
  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>(createEmptyProviderDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [testingId, setTestingId] = useState("")
  const [connectionResults, setConnectionResults] = useState<
    Record<string, ProviderConnectionResult>
  >(storedConnectionResults)
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelFetchError, setModelFetchError] = useState("")
  const [modelCapabilities, setModelCapabilities] =
    useState<ModelCapabilityCatalog | null>(null)
  const [testingBalance, setTestingBalance] = useState(false)
  const [balanceTestError, setBalanceTestError] = useState("")
  const [balanceTestNotice, setBalanceTestNotice] = useState("")
  const [dialogError, setDialogError] = useState("")
  const [originalBaseUrl, setOriginalBaseUrl] = useState("")
  const dialogSession = useRef(0)
  const initialDraft = useRef("")
  const baselineDraft = useRef<ProviderDraft | null>(null)
  const baselineRevision = useRef<number | null>(null)
  const dialogRequests = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const dirty = dialogOpen && JSON.stringify(draft) !== initialDraft.current
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dialogOpen, draft, onDirtyChange])

  function abortDialogRequests() {
    for (const controller of dialogRequests.current.values()) controller.abort()
    dialogRequests.current.clear()
  }

  function startDialogRequest(name: string) {
    dialogRequests.current.get(name)?.abort()
    const controller = new AbortController()
    dialogRequests.current.set(name, controller)
    return { controller, session: dialogSession.current }
  }

  function requestIsCurrent(session: number, controller: AbortController) {
    return session === dialogSession.current && !controller.signal.aborted
  }

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextCapabilities] = await Promise.all([
        apiRequest<ProviderConfig>("/api/providers"),
        apiRequest<ModelCapabilityCatalog>("/api/model-capabilities"),
      ])
      setConfig(nextConfig)
      setModelCapabilities(nextCapabilities)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed)
    } finally {
      setLoading(false)
    }
  }, [messages.failed])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      abortDialogRequests()
    }
  }, [refresh])

  function resetDialogFeedback() {
    setFetchedModels([])
    setModelFetchError("")
    setBalanceTestError("")
    setBalanceTestNotice("")
  }

  function openCreate() {
    abortDialogRequests()
    dialogSession.current += 1
    const nextDraft = createEmptyProviderDraft()
    setEditingId(null)
    setOriginalBaseUrl("")
    setDraft(nextDraft)
    baselineDraft.current = nextDraft
    baselineRevision.current = null
    initialDraft.current = JSON.stringify(nextDraft)
    setError("")
    setDialogError("")
    resetDialogFeedback()
    setDialogOpen(true)
  }

  function openEdit(provider: Provider) {
    abortDialogRequests()
    dialogSession.current += 1
    const nextDraft = providerToDraft(provider)
    setEditingId(provider.id)
    setOriginalBaseUrl(provider.baseUrl)
    setDraft(nextDraft)
    baselineDraft.current = nextDraft
    baselineRevision.current = config?.revision ?? null
    initialDraft.current = JSON.stringify(nextDraft)
    setError("")
    setDialogError("")
    resetDialogFeedback()
    setDialogOpen(true)
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { controller, session } = startDialogRequest("save")
    setSaving(true)
    setDialogError("")
    try {
      const payload = providerDraftPayload(draft, {
        baseline: baselineDraft.current,
        originalBaseUrl: baselineDraft.current?.baseUrl,
        originChangedMessage: messages.reenterKeysForOrigin,
      })
      if (editingId && baselineRevision.current === null) {
        throw new Error(messages.concurrentChange)
      }
      const requestPayload = editingId
        ? providerUpdatePayload(draft, baselineRevision.current as number, {
            baseline: baselineDraft.current,
            originalBaseUrl: baselineDraft.current?.baseUrl,
            originChangedMessage: messages.reenterKeysForOrigin,
          })
        : payload
      const next = await apiRequest<ProviderConfig>(
        editingId
          ? `/api/providers/${encodeURIComponent(editingId)}`
          : "/api/providers",
        {
          method: editingId ? "PATCH" : "POST",
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        }
      )
      if (!requestIsCurrent(session, controller)) return
      setConfig(next)
      if (editingId) {
        setConnectionResults((current) =>
          withoutConnectionResult(current, editingId)
        )
      }
      baselineDraft.current = draft
      baselineRevision.current = next.revision
      initialDraft.current = JSON.stringify(draft)
      abortDialogRequests()
      setSaving(false)
      dialogSession.current += 1
      setDialogOpen(false)
      await onChanged?.()
      if (setupMode && !next.setupPending) await onConfigured?.()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : messages.failed
      if (
        requestIsCurrent(session, controller) &&
        message.includes("provider configuration changed")
      ) {
        await refresh()
      }
      if (requestIsCurrent(session, controller)) {
        setDialogError(message)
      }
    } finally {
      if (session === dialogSession.current) setSaving(false)
    }
  }

  async function patchProvider(id: string, payload: Record<string, unknown>) {
    setError("")
    setNotice("")
    if (!config) {
      setError(messages.concurrentChange)
      return
    }
    try {
      const next = await apiRequest<ProviderConfig>(
        `/api/providers/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...payload,
            expectedRevision: config.revision,
          }),
        }
      )
      setConfig(next)
      await onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed)
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
      setConnectionResults((current) => {
        return withoutConnectionResult(current, id)
      })
      await onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed)
    }
  }

  async function testProvider(id: string) {
    setTestingId(id)
    setNotice("")
    setError("")
    try {
      const result = await apiRequest<{ status: number; latencyMs: number }>(
        `/api/providers/${encodeURIComponent(id)}/test`,
        {
          method: "POST",
          body: "{}",
        }
      )
      setConnectionResults((current) =>
        storeConnectionResults({
          ...current,
          [id]: {
            state: "available",
            testedAt: Date.now(),
            status: result.status,
            latencyMs: result.latencyMs,
          },
        })
      )
      setNotice(`${messages.connected}: ${id}`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : messages.failed
      setConnectionResults((current) =>
        storeConnectionResults({
          ...current,
          [id]: { state: "failed", testedAt: Date.now(), message },
        })
      )
      setError(message)
    } finally {
      setTestingId("")
    }
  }

  async function fetchModels() {
    const { controller, session } = startDialogRequest("models")
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
          signal: controller.signal,
        }
      )
      if (!requestIsCurrent(session, controller)) return
      setFetchedModels(result.models)
      if (!result.models.length) {
        setModelFetchError(messages.noModelsFound)
      }
    } catch (cause) {
      if (!requestIsCurrent(session, controller)) return
      setFetchedModels([])
      setModelFetchError(
        cause instanceof Error ? cause.message : messages.failed
      )
    } finally {
      if (session === dialogSession.current) setFetchingModels(false)
    }
  }

  async function testBalanceQuery() {
    const { controller, session } = startDialogRequest("balance")
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
        signal: controller.signal,
      })
      if (!requestIsCurrent(session, controller)) return
      setBalanceTestNotice(
        messages.balanceTested(balanceResultAmount(result, locale))
      )
    } catch (cause) {
      if (!requestIsCurrent(session, controller)) return
      setBalanceTestError(
        cause instanceof Error ? cause.message : messages.failed
      )
    } finally {
      if (session === dialogSession.current) setTestingBalance(false)
    }
  }

  function addFetchedModel(model: FetchedModel) {
    setDraft((value) => addFetchedModelToDraft(value, model, modelCapabilities))
  }

  function clearConnectionResult(id: string) {
    setConnectionResults((current) => withoutConnectionResult(current, id))
  }

  function changeDialogOpen(open: boolean) {
    if (open) {
      setDialogOpen(true)
      return
    }
    const dirty = JSON.stringify(draft) !== initialDraft.current
    if (dirty) {
      setDiscardDialogOpen(true)
      return
    }
    closeDialog()
  }

  function closeDialog() {
    abortDialogRequests()
    dialogSession.current += 1
    setSaving(false)
    setFetchingModels(false)
    setTestingBalance(false)
    setDialogOpen(false)
    setDialogError("")
  }

  function discardDialogChanges() {
    setDiscardDialogOpen(false)
    closeDialog()
  }

  return {
    addFetchedModel,
    balanceTestError,
    balanceTestNotice,
    clearConnectionResult,
    config,
    connectionResults,
    deleteProvider,
    discardDialogChanges,
    discardDialogOpen,
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
    modelCapabilities,
    notice,
    originalBaseUrl,
    openCreate,
    openEdit,
    patchProvider,
    refresh,
    saveProvider,
    saving,
    setDialogOpen: changeDialogOpen,
    setDiscardDialogOpen,
    setDraft,
    testBalanceQuery,
    testingBalance,
    testingId,
    testProvider,
  }
}
