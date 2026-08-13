// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { ToastProvider, useToast } from "./toast"

function ToastProbe() {
  const { showToast } = useToast()
  return (
    <button
      type="button"
      onClick={() => showToast("hello toast", "success")}
    >
      show
    </button>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ToastProvider", () => {
  test("renders a toast for the shown message", async () => {
    render(
      <ToastProvider>
        <ToastProbe />
      </ToastProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "show" }))
    expect(await screen.findByText("hello toast")).toBeInTheDocument()
  })

  test("auto-dismisses the toast after four seconds", () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <ToastProbe />
      </ToastProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "show" }))
    expect(screen.getByText("hello toast")).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByText("hello toast")).toBeNull()
  })
})
