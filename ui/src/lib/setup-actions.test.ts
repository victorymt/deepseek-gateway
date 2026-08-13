import { describe, expect, test } from "vitest"

import { codexRevisionPending } from "./setup-actions"

describe("setup actions", () => {
  test("only reports a generated Codex revision that is not confirmed", () => {
    expect(codexRevisionPending("", "")).toBe(false)
    expect(codexRevisionPending("revision-a", "")).toBe(true)
    expect(codexRevisionPending("revision-a", "revision-a")).toBe(false)
    expect(codexRevisionPending("revision-b", "revision-a")).toBe(true)
  })
})
