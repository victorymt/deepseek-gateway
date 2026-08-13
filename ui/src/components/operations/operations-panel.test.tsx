// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"

import { Component, useCallback } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import {
  OperationsPageErrorBoundary,
  OperationsPanel,
} from "../operations-panel"
import { useOperationsAutoRefresh, useOperationsPage } from "./page-state"

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  })
}

function apiPayload(url: string) {
  if (url.startsWith("/api/integrations")) return { integrations: [] }
  if (url.startsWith("/api/logs")) {
    return { logs: [], total: 0, hasMore: false, nextCursor: null }
  }
  if (url.startsWith("/api/usage")) {
    return {
      range: "30d",
      total: {
        requests: 0,
        success: 0,
        errors: 0,
        ratelimited: 0,
        tokens: 0,
      },
      points: [],
      providers: {},
      models: {},
    }
  }
  if (url === "/api/providers") return { providers: [] }
  throw new Error(`unexpected request: ${url}`)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("operations panel state", () => {
  test("keeps visited page drafts and filters mounted, then resets after leaving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(json(apiPayload(String(input))))
      )
    )
    const props = { locale: "en" as const, health: null }
    const view = render(<OperationsPanel {...props} kind="integrations" />)

    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft webhook" },
    })

    view.rerender(<OperationsPanel {...props} kind="logs" />)
    const search = await screen.findByLabelText("Search logs")
    fireEvent.change(search, { target: { value: "timeout" } })
    const refreshInterval = screen.getByLabelText("Auto refresh interval")
    const refreshInput = document.getElementById(
      `${refreshInterval.id}-hidden-input`
    )
    if (!(refreshInput instanceof HTMLInputElement)) {
      throw new Error("refresh interval input is unavailable")
    }
    fireEvent.change(refreshInput, { target: { value: "5" } })

    view.rerender(<OperationsPanel {...props} kind="models" />)
    await screen.findByText("No models configured")
    view.rerender(<OperationsPanel {...props} kind="integrations" />)
    expect(screen.getByLabelText("Name")).toHaveValue("Draft webhook")

    view.rerender(<OperationsPanel {...props} kind="logs" />)
    expect(screen.getByLabelText("Search logs")).toHaveValue("timeout")
    expect(screen.getByLabelText("Auto refresh interval")).toHaveTextContent(
      "5s"
    )

    view.unmount()
    render(<OperationsPanel {...props} kind="integrations" />)
    await screen.findByRole("button", { name: "Add integration" })
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument()
  })

  test("reports integration drafts as dirty until they are cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(json(apiPayload(String(input))))
      )
    )
    const onDirtyChange = vi.fn()
    render(
      <OperationsPanel
        locale="en"
        health={null}
        kind="integrations"
        onDirtyChange={onDirtyChange}
      />
    )

    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenCalledWith("integrations", true)
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenCalledWith("integrations", false)
    )
  })

  test("shows integration test status and latency", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === "/api/integrations" && !init?.method) {
          return Promise.resolve(
            json({
              integrations: [
                {
                  id: "status-api",
                  name: "Status API",
                  type: "openai",
                  baseUrl: "https://status.example/v1",
                  enabled: true,
                },
              ],
            })
          )
        }
        if (url === "/api/integrations/status-api/test") {
          return Promise.resolve(json({ ok: true, status: 204, latencyMs: 37 }))
        }
        return Promise.resolve(json(apiPayload(url)))
      })
    )
    render(<OperationsPanel locale="en" health={null} kind="integrations" />)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    expect(await screen.findByText("HTTP 204 · 37 ms")).toBeInTheDocument()
  })
})

type Deferred = {
  signal: AbortSignal
  resolve: (value: string) => void
}

function RequestProbe({
  active,
  requests,
  automatic = false,
}: {
  active: boolean
  requests: Deferred[]
  automatic?: boolean
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      new Promise<string>((resolve) => requests.push({ signal, resolve })),
    [requests]
  )
  const page = useOperationsPage(load, active, "initial")
  useOperationsAutoRefresh(page.refresh, automatic ? 1 : 0, false, active)
  return (
    <div>
      <output>{page.data}</output>
      <button type="button" onClick={() => void page.refresh()}>
        refresh
      </button>
    </div>
  )
}

describe("operations request lifecycle", () => {
  test("aborts reads while hidden and refreshes once when reactivated", async () => {
    vi.useFakeTimers()
    const requests: Deferred[] = []
    const view = render(<RequestProbe active requests={requests} automatic />)

    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(requests).toHaveLength(1)
    view.rerender(<RequestProbe active={false} requests={requests} automatic />)
    expect(requests[0].signal.aborted).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(requests).toHaveLength(1)

    view.rerender(<RequestProbe active requests={requests} automatic />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(requests).toHaveLength(2)
  })

  test("does not let a stale response overwrite the latest data", async () => {
    const requests: Deferred[] = []
    render(<RequestProbe active requests={requests} />)
    await waitFor(() => expect(requests).toHaveLength(1))

    fireEvent.click(screen.getByRole("button", { name: "refresh" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0].signal.aborted).toBe(true)

    await act(async () => requests[1].resolve("latest"))
    expect(screen.getByText("latest")).toBeInTheDocument()
    await act(async () => requests[0].resolve("stale"))
    expect(screen.getByText("latest")).toBeInTheDocument()
    expect(screen.queryByText("stale")).not.toBeInTheDocument()
  })
})

class BrokenPage extends Component {
  render(): never {
    throw new Error("chunk failed")
  }
}

describe("operations page recovery", () => {
  test("isolates a failed page and exposes the localized reload action", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const reload = vi.fn()
    render(
      <>
        <p>healthy sibling</p>
        <OperationsPageErrorBoundary locale="zh-CN" reload={reload}>
          <BrokenPage />
        </OperationsPageErrorBoundary>
      </>
    )

    expect(screen.getByText("healthy sibling")).toBeInTheDocument()
    expect(screen.getByText("页面加载失败")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }))
    expect(reload).toHaveBeenCalledOnce()
  })
})
