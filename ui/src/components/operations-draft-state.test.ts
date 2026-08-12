import { describe, expect, test } from "vitest"

import { draftAfterSubmit } from "./operations-draft-state"

describe("operations draft state", () => {
  test("retains the submitted draft after a failed request", () => {
    const draft = { name: "Local", baseUrl: "https://example.com" }
    expect(draftAfterSubmit(draft, draft, false)).toBe(draft)
  })

  test("closes only the successfully saved draft", () => {
    const submitted = { name: "Local" }
    const editedWhileSaving = { name: "Local edited" }

    expect(draftAfterSubmit(submitted, submitted, true)).toBeNull()
    expect(draftAfterSubmit(editedWhileSaving, submitted, true)).toBe(
      editedWhileSaving
    )
  })
})
