import { describe, expect, test } from "vitest"

import {
  isOperationsSection,
  sectionFromHash,
  sectionHash,
} from "./app-navigation"

describe("dashboard hash navigation", () => {
  test("restores known sections and accepts legacy operations hashes", () => {
    expect(sectionFromHash("#logs")).toBe("logs")
    expect(sectionFromHash("#/settings")).toBe("settings")
    expect(sectionFromHash("#operations/usage")).toBe("usage")
  })

  test("falls back to providers for empty or unknown hashes", () => {
    expect(sectionFromHash("")).toBe("providers")
    expect(sectionFromHash("#unknown")).toBe("providers")
    expect(sectionHash("integrations")).toBe("#integrations")
  })

  test("identifies pages that share the mounted Operations workspace", () => {
    expect(isOperationsSection("integrations")).toBe(true)
    expect(isOperationsSection("logs")).toBe(true)
    expect(isOperationsSection("settings")).toBe(false)
  })
})
