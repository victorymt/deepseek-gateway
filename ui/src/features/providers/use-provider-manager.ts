import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import type { Locale } from "@/components/language-provider"
import type { BalanceResult, Provider, ProviderConfig } from "@/gateway-types"
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
}

export function useProviderManager({
  locale,
  messages,
  setupMode,
  onConfigured,
}: UseProviderManagerOptions) {
  const [config, setConfig] = useState<ProviderConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft>(createEmptyProviderDraft)
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
  const [dialogError, setDialogError] = useState("")
  const [originalBaseUrl, setOriginalBaseUrl] = useState("")
  const dialogSession = useRef(0)
  const initialDraft = useRef("")
  const baselineDraft = useRef<ProviderDraft | null>(null)
  const baselineRevision = useRef<number | null>(null)
  const dialogRequests = useRef(new Map<string, AbortController>())

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
      setConfig(await apiRequest<ProviderConfig>("/api/providers"))
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
      baselineDraft.current = draft
      baselineRevision.current = next.revision
      initialDraft.current = JSON.stringify(draft)
      abortDialogRequests()
      setSaving(false)
      dialogSession.current += 1
      setDialogOpen(false)
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed)
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
      setNotice(`${messages.connected}: ${id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed)
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
    setDraft((value) => addFetchedModelToDraft(value, model))
  }

  function changeDialogOpen(open: boolean) {
    if (open) {
      setDialogOpen(true)
      return
    }
    const dirty = JSON.stringify(draft) !== initialDraft.current
    if (dirty && !window.confirm(messages.discardChanges)) return
    abortDialogRequests()
    dialogSession.current += 1
    setSaving(false)
    setFetchingModels(false)
    setTestingBalance(false)
    setDialogOpen(false)
    setDialogError("")
  }

  return {
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
    originalBaseUrl,
    openCreate,
    openEdit,
    patchProvider,
    saveProvider,
    saving,
    setDialogOpen: changeDialogOpen,
    setDraft,
    testBalanceQuery,
    testingBalance,
    testingId,
    testProvider,
  }
}
