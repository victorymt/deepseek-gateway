import { describe, expect, test } from "vitest"

import { shouldAutoRefresh } from "./page-state"

describe("operations page refresh policy", () => {
  test("refreshes only when an interval is enabled and editing is not paused", () => {
    expect(shouldAutoRefresh(0, false)).toBe(false)
    expect(shouldAutoRefresh(5, false)).toBe(true)
    expect(shouldAutoRefresh(15, true)).toBe(false)
  })
})
