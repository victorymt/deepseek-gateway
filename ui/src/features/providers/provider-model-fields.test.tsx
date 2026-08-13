import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"

import { providerCopy } from "./provider-copy"
import { createEmptyProviderDraft } from "./provider-editor-state"
import { ProviderModelFields } from "./provider-model-fields"

function renderModelFields(
  overrides: Partial<ReturnType<typeof createEmptyProviderDraft>> = {}
) {
  const draft = { ...createEmptyProviderDraft(), ...overrides }
  return renderToStaticMarkup(
    <ProviderModelFields
      copy={providerCopy.en}
      draft={draft}
      fetchedModels={[]}
      fetching={false}
      fetchError=""
      modelCapabilities={null}
      setDraft={() => undefined}
      onAddFetchedModel={() => undefined}
      onFetchModels={async () => undefined}
    />
  )
}

describe("ProviderModelFields", () => {
  test("shows Native Responses overrides only for generic Responses providers", () => {
    const genericResponses = renderModelFields()
    const officialDeepSeek = renderModelFields({ apiProfile: "deepseek" })
    const proxyChat = renderModelFields({ upstreamFormat: "chat-completions" })

    expect(genericResponses).toContain("Context window")
    expect(genericResponses).toContain("Parallel tool calls")
    expect(genericResponses).toContain("Base instructions")
    expect(officialDeepSeek).not.toContain("Context window")
    expect(proxyChat).not.toContain("Context window")
  })
})
