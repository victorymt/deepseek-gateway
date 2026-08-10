import { useState } from "react"

import { apiRequest } from "@/lib/api-request"

import type {
  KeyAction,
  KeyFeedback,
  KeyTestResult,
  ProviderKeyCopy,
} from "./types"

export function useKeyActions({
  providerId,
  keyName,
  copy,
  onRefresh,
  onFeedback,
}: {
  providerId: string
  keyName: string
  copy: ProviderKeyCopy
  onRefresh: () => Promise<void>
  onFeedback: (feedback: KeyFeedback) => void
}) {
  const [pending, setPending] = useState<KeyAction | null>(null)
  const keyUrl = `/api/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyName)}`

  async function runAction(
    action: Exclude<KeyAction, "test">,
    request: () => Promise<unknown>,
    successMessage: string
  ) {
    setPending(action)
    onFeedback(null)
    try {
      await request()
      await onRefresh()
      onFeedback({ kind: "success", message: successMessage })
      return true
    } catch (cause) {
      onFeedback({
        kind: "error",
        message: cause instanceof Error ? cause.message : copy.actionFailed,
      })
      return false
    } finally {
      setPending(null)
    }
  }

  async function toggle(checked: boolean) {
    await runAction(
      "toggle",
      () =>
        apiRequest(keyUrl, {
          method: "PATCH",
          body: JSON.stringify({ enabled: checked }),
        }),
      copy.keyUpdated
    )
  }

  async function test() {
    setPending("test")
    onFeedback(null)
    try {
      const result = await apiRequest<KeyTestResult>(`${keyUrl}/test`, {
        method: "POST",
        body: "{}",
      })
      onFeedback({
        kind: "success",
        message: copy.keyConnected(result.status, result.latencyMs),
      })
    } catch (cause) {
      onFeedback({
        kind: "error",
        message: cause instanceof Error ? cause.message : copy.actionFailed,
      })
    } finally {
      setPending(null)
    }
  }

  async function refreshBalance() {
    await runAction(
      "balance",
      () =>
        apiRequest(`${keyUrl}/balance`, {
          method: "POST",
          body: "{}",
        }),
      copy.balanceRefreshed
    )
  }

  function updateWeight(weight: number) {
    return runAction(
      "weight",
      () =>
        apiRequest(keyUrl, {
          method: "PATCH",
          body: JSON.stringify({ weight }),
        }),
      copy.keyUpdated
    )
  }

  async function remove() {
    await runAction(
      "delete",
      () => apiRequest(keyUrl, { method: "DELETE" }),
      copy.keyDeleted
    )
  }

  return { pending, refreshBalance, remove, test, toggle, updateWeight }
}
