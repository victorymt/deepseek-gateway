// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { App } from "./App"
import { LanguageProvider } from "./components/language-provider"
import { ThemeProvider } from "./components/theme-provider"
import { TooltipProvider } from "./components/ui/tooltip"
import type { Health } from "./gateway-types"

function json(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
}

function health(setupRequired = false): Health {
  return {
    status: "ok",
    setupRequired,
    version: "2.0.0",
    mock: true,
    upstream: "mock",
    defaultProvider: "demo",
    defaultModel: "demo.model",
    port: 8787,
    uptime: 12,
    total: { requests: 5, success: 4, errors: 1, ratelimited: 0, tokens: 42 },
    keys: [],
    providers: setupRequired
      ? []
      : [
          {
            id: "demo",
            name: "Demo",
            baseUrl: "mock",
            upstreamFormat: "responses",
            enabled: true,
            balanceQueryEnabled: false,
            modelCount: 1,
            total: {
              requests: 5,
              success: 4,
              errors: 1,
              ratelimited: 0,
              tokens: 42,
            },
            keys: [
              {
                name: "primary",
                weight: 1,
                enabled: true,
                alwaysTry: false,
                state: "healthy",
                invalid: false,
                unhealthy: false,
                lastError: "",
                balanceError: "",
                inFlight: 3,
                total: 5,
                success: 4,
                errors: 1,
                ratelimited: 0,
                failureCount: 0,
                cooldownSec: 0,
                lastUsed: null,
                balanceUpdatedAt: null,
              },
            ],
          },
        ],
  }
}

function renderApp() {
  return render(
    <ThemeProvider defaultTheme="light" storageKey="test-theme">
      <LanguageProvider defaultLocale="en" storageKey="test-language">
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </LanguageProvider>
    </ThemeProvider>
  )
}

function dashboardFetch(currentHealth: Health) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "/health") return Promise.resolve(json(currentHealth))
    if (url === "/api/settings") {
      return Promise.resolve(json({ restartRequired: [] }))
    }
    if (url === "/api/codex/config") {
      return Promise.resolve(json({ revision: "r1" }))
    }
    if (url === "/api/integrations" && !init?.method) {
      return Promise.resolve(json({ integrations: [] }))
    }
    if (url === "/api/providers") {
      return Promise.resolve(
        json({
          schemaVersion: 2,
          revision: 1,
          setupPending: currentHealth.setupRequired,
          defaultProvider: "demo",
          defaultModel: "demo.model",
          providers: currentHealth.setupRequired
            ? []
            : [
                {
                  id: "demo",
                  name: "Demo",
                  baseUrl: "https://example.com",
                  upstreamFormat: "responses",
                  apiProfile: "generic",
                  supportsEncryptedAgentMessages: false,
                  supportsPromptCacheKey: false,
                  keyRouting: "balanced",
                  enabled: true,
                  models: [
                    {
                      id: "model",
                      name: "Model",
                      upstreamModel: "model",
                      inputModalities: ["text"],
                      supportsHostedWebSearch: false,
                      supportsCustomApplyPatch: false,
                      alias: "demo.model",
                    },
                  ],
                  keys: [
                    {
                      name: "primary",
                      weight: 1,
                      enabled: true,
                      alwaysTry: false,
                      maskedKey: "sk-***",
                      fingerprint: "fingerprint",
                    },
                  ],
                  balanceQuery: null,
                },
              ],
        })
      )
    }
    if (url === "/api/model-capabilities") {
      return Promise.resolve(
        json({
          schemaVersion: 1,
          unknownModel: { inputModalities: ["text"] },
          models: [],
        })
      )
    }
    if (url === "/api/runtime/stop") {
      return Promise.resolve(json({ stopping: true }, { status: 202 }))
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, "", "/")
})

describe("gateway console workflows", () => {
  test("shows login rate limiting separately from an invalid token", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/health") {
        return Promise.resolve(json({}, { status: 401 }))
      }
      return Promise.resolve(
        json(
          { error: { message: "too many login attempts" } },
          { status: 429, headers: { "retry-after": "3" } }
        )
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    fireEvent.change(await screen.findByLabelText("Admin token"), {
      target: { value: "wrong" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(
      await screen.findByText("Too many attempts. Try again in 3s.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled()
  })

  test("accepts an HTTP-date Retry-After value", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/health") {
        return Promise.resolve(json({}, { status: 401 }))
      }
      return Promise.resolve(
        json(
          { error: { message: "too many login attempts" } },
          {
            status: 429,
            headers: {
              "retry-after": new Date(Date.now() + 30_000).toUTCString(),
            },
          }
        )
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    fireEvent.change(await screen.findByLabelText("Admin token"), {
      target: { value: "wrong" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(
      await screen.findByText(/Too many attempts\. Try again in \d+s\./)
    ).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled()
  })

  test("locks navigation until the first Provider is configured", async () => {
    window.history.replaceState({}, "", "#settings")
    vi.stubGlobal("fetch", dashboardFetch(health(true)))
    renderApp()

    expect(
      await screen.findByRole("button", { name: "Settings" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "title",
      "Configure your first Provider to unlock"
    )
    expect(
      screen.getByRole("heading", { name: /first Provider/i })
    ).toBeInTheDocument()
  })

  test("confirms stop and reports active requests before posting", async () => {
    window.history.replaceState({}, "", "#dashboard")
    const fetchMock = dashboardFetch(health())
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "Stop gateway" }))
    expect(
      screen.getByText(/3 request\(s\) are currently in flight/)
    ).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === "/api/runtime/stop")
    ).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Stop Gateway" }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === "/api/runtime/stop"
        )
      ).toBe(true)
    )
  })

  test("protects an integration draft when leaving Operations", async () => {
    window.history.replaceState({}, "", "#integrations")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft webhook" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))

    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Draft webhook")
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }))
    expect(
      await screen.findByRole("heading", { name: "Dashboard" })
    ).toBeInTheDocument()
    expect(window.location.hash).toBe("#dashboard")
  })

  test("signs out without reusing an old intent or prompting twice", async () => {
    window.history.replaceState({}, "", "#integrations")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "\u5207\u6362\u5230\u4e2d\u6587" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }))

    const unloadEvent = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unloadEvent)
    expect(unloadEvent.defaultPrevented).toBe(false)
    expect(
      screen.getByRole("button", { name: "\u5207\u6362\u5230\u4e2d\u6587" })
    ).toBeInTheDocument()
  })

  test("protects a key import draft from unload and accidental closing", async () => {
    window.history.replaceState({}, "", "#providers")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "API keys" }))
    fireEvent.click(await screen.findByRole("button", { name: "Import keys" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Paste text" }), {
      target: { value: "secondary=sk-example" },
    })

    const unloadEvent = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unloadEvent)
    expect(unloadEvent.defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(
      screen.getByRole("heading", { name: "Discard unsaved key changes?" })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("textbox", { name: "Paste text" })).toHaveValue(
      "secondary=sk-example"
    )
  })

  test("protects a key weight draft from accidental closing", async () => {
    window.history.replaceState({}, "", "#providers")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "API keys" }))
    fireEvent.click(await screen.findByRole("button", { name: "Edit weight" }))
    const weightInput = screen.getByRole("spinbutton", { name: "Weight" })
    fireEvent.change(weightInput, { target: { value: "2" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(
      screen.getByRole("heading", { name: "Discard unsaved key changes?" })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("spinbutton", { name: "Weight" })).toHaveValue(2)
  })

  test("preserves browser history when a dirty back navigation is cancelled", async () => {
    window.history.replaceState({}, "", "#dashboard")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "Integrations" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Back-safe draft" },
    })

    window.history.back()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe("#integrations"))
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(screen.getByLabelText("Name")).toHaveValue("Back-safe draft")

    window.history.back()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe("#integrations"))
  })

  test("protects drafts when navigating to an unindexed history entry", async () => {
    window.history.replaceState({}, "", "#dashboard")
    window.history.pushState({}, "", "#integrations")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Legacy history draft" },
    })

    window.history.back()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe("#integrations"))
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(screen.getByLabelText("Name")).toHaveValue("Legacy history draft")

    window.history.back()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }))
    expect(
      await screen.findByRole("heading", { name: "Dashboard" })
    ).toBeInTheDocument()
    expect(window.location.hash).toBe("#dashboard")
  })

  test("syncs same-section history before protecting a forward navigation", async () => {
    window.history.replaceState({}, "", "#integrations")
    vi.stubGlobal("fetch", dashboardFetch(health()))
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "Dashboard" }))
    fireEvent.click(await screen.findByRole("button", { name: "Integrations" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Add integration" })
    )
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Same-section draft" },
    })

    window.history.go(-2)
    await waitFor(() => expect(window.location.hash).toBe("#integrations"))
    window.history.forward()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe("#integrations"))
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))

    window.history.forward()
    expect(
      await screen.findByRole("heading", { name: "Discard unsaved changes?" })
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Name")).toHaveValue("Same-section draft")
  })

  test("shows a stop request failure inside the confirmation dialog", async () => {
    window.history.replaceState({}, "", "#dashboard")
    const fetchMock = dashboardFetch(health())
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/runtime/stop") {
          return Promise.resolve(
            json({ error: { message: "runtime busy" } }, { status: 503 })
          )
        }
        return dashboardFetch(health())(input, init)
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "Stop gateway" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop Gateway" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("runtime busy")
    expect(screen.getByText("Stop Gateway?")).toBeInTheDocument()
  })

  test("times out a hanging stop request and re-enables the dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.replaceState({}, "", "#dashboard")
    const fetchMock = dashboardFetch(health())
    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/runtime/stop") {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"))
            })
          })
        }
        return dashboardFetch(health())(input, init)
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    renderApp()

    fireEvent.click(await screen.findByRole("button", { name: "Stop gateway" }))
    fireEvent.click(screen.getByRole("button", { name: "Stop Gateway" }))
    await vi.advanceTimersByTimeAsync(8_000)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The stop request timed out"
    )
    expect(screen.getByRole("button", { name: "Stop Gateway" })).toBeEnabled()
    vi.useRealTimers()
  })
})
