import { useCallback, useEffect, useState } from "react"

import type { CodexArtifacts, GatewaySettings } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

export const CONFIG_CHANGED_EVENT = "gateway-config-changed"
export const CODEX_APPLIED_EVENT = "gateway-codex-applied"
const CODEX_REVISION_KEY = "deepseek-gateway.codex-applied-revision"

export function notifyConfigChanged() {
  window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT))
}

export function appliedCodexRevision() {
  try {
    return window.localStorage.getItem(CODEX_REVISION_KEY) || ""
  } catch {
    return ""
  }
}

export function markCodexRevisionApplied(revision: string) {
  try {
    window.localStorage.setItem(CODEX_REVISION_KEY, revision)
  } catch {
    // The confirmation remains valid for this page even when storage is blocked.
  }
  window.dispatchEvent(
    new CustomEvent(CODEX_APPLIED_EVENT, { detail: { revision } })
  )
}

export function codexRevisionPending(
  currentRevision: string,
  confirmedRevision: string
) {
  return Boolean(currentRevision && currentRevision !== confirmedRevision)
}

export function useSetupActions(enabled: boolean) {
  const [settings, setSettings] = useState<GatewaySettings | null>(null)
  const [artifacts, setArtifacts] = useState<CodexArtifacts | null>(null)
  const [appliedRevision, setAppliedRevision] = useState(appliedCodexRevision)

  const refresh = useCallback(async () => {
    if (!enabled) return
    const [settingsResult, artifactsResult] = await Promise.allSettled([
      apiRequest<GatewaySettings>("/api/settings"),
      apiRequest<CodexArtifacts>("/api/codex/config"),
    ])
    if (settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value)
    }
    if (artifactsResult.status === "fulfilled") {
      setArtifacts(artifactsResult.value)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(() => void refresh(), 0)
    const handleConfigChange = () => void refresh()
    const handleApplied = (event: Event) => {
      const revision = (event as CustomEvent<{ revision?: string }>).detail
        ?.revision
      setAppliedRevision(revision || appliedCodexRevision())
    }
    window.addEventListener(CONFIG_CHANGED_EVENT, handleConfigChange)
    window.addEventListener(CODEX_APPLIED_EVENT, handleApplied)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener(CONFIG_CHANGED_EVENT, handleConfigChange)
      window.removeEventListener(CODEX_APPLIED_EVENT, handleApplied)
    }
  }, [enabled, refresh])

  return {
    codexRevision: artifacts?.revision || "",
    codexPending: codexRevisionPending(
      artifacts?.revision || "",
      appliedRevision
    ),
    restartRequired: settings?.restartRequired ?? [],
    refresh,
  }
}
