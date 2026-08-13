import { useCallback, useEffect, useRef, useState } from "react"

import { apiRequest } from "@/lib/api-request"

export function shouldAutoRefresh(seconds: number, paused: boolean): boolean {
  return seconds > 0 && !paused
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Request failed"
}

function isAbortError(cause: unknown) {
  return cause instanceof Error && cause.name === "AbortError"
}

export type OperationsActionResult<T> = {
  ok: boolean
  data?: T
  error?: unknown
}

export function useOperationsPage<T>(
  load: (signal: AbortSignal) => Promise<T>,
  active: boolean,
  initialData: T
) {
  const [data, setData] = useState(initialData)
  const [loading, setLoading] = useState(active)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  const activeRef = useRef(active)
  const mountedRef = useRef(true)
  const requestRef = useRef<AbortController | null>(null)
  const requestSequenceRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!activeRef.current || !mountedRef.current) return

    requestRef.current?.abort()
    const controller = new AbortController()
    const sequence = ++requestSequenceRef.current
    requestRef.current = controller
    setLoading(true)
    setError("")
    try {
      const nextData = await load(controller.signal)
      if (
        mountedRef.current &&
        activeRef.current &&
        sequence === requestSequenceRef.current
      ) {
        setData(nextData)
      }
    } catch (cause) {
      if (
        !isAbortError(cause) &&
        mountedRef.current &&
        activeRef.current &&
        sequence === requestSequenceRef.current
      ) {
        setError(errorMessage(cause))
      }
    } finally {
      if (
        mountedRef.current &&
        activeRef.current &&
        sequence === requestSequenceRef.current
      ) {
        setLoading(false)
      }
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [load])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeRef.current = false
      requestSequenceRef.current += 1
      requestRef.current?.abort()
      requestRef.current = null
    }
  }, [])

  useEffect(() => {
    activeRef.current = active
    if (active) {
      const timer = window.setTimeout(() => void refresh(), 0)
      return () => window.clearTimeout(timer)
    }
    requestSequenceRef.current += 1
    requestRef.current?.abort()
    requestRef.current = null
  }, [active, refresh])

  const actionWithResult = useCallback(
    async <T>(
      path: string,
      init?: RequestInit,
      message = "Saved"
    ): Promise<OperationsActionResult<T>> => {
      setPendingAction(path)
      setError("")
      setNotice("")
      try {
        const result = await apiRequest<T>(path, init)
        if (!mountedRef.current) return { ok: true, data: result }
        setNotice(message)
        if (activeRef.current) await refresh()
        return { ok: true, data: result }
      } catch (cause) {
        if (mountedRef.current) setError(errorMessage(cause))
        return { ok: false, error: cause }
      } finally {
        if (mountedRef.current) setPendingAction("")
      }
    },
    [refresh]
  )

  const action = useCallback(
    async (path: string, init?: RequestInit, message = "Saved") => {
      const result = await actionWithResult(path, init, message)
      return result.ok
    },
    [actionWithResult]
  )

  const isMounted = useCallback(() => mountedRef.current, [])

  return {
    data,
    loading,
    error,
    notice,
    pendingAction,
    refresh,
    action,
    actionWithResult,
    isMounted,
  }
}

export function useOperationsAutoRefresh(
  refresh: () => Promise<void>,
  seconds: number,
  paused: boolean,
  active: boolean
) {
  useEffect(() => {
    if (!active || !shouldAutoRefresh(seconds, paused)) return
    const timer = window.setInterval(() => void refresh(), seconds * 1000)
    return () => window.clearInterval(timer)
  }, [refresh, seconds, paused, active])
}
