import { describe, expect, test } from "vitest"

import type { Provider } from "@/gateway-types"

import {
  addFetchedModelToDraft,
  balanceResultAmount,
  createEmptyProviderDraft,
  providerDraftPayload,
  providerOriginsDiffer,
  providerToDraft,
  providerUpdatePayload,
  setProviderUpstreamFormat,
} from "./provider-editor-state"

const provider: Provider = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  upstreamFormat: "responses",
  supportsEncryptedAgentMessages: true,
  enabled: true,
  models: [
    {
      id: "chat",
      name: "Chat",
      upstreamModel: "deepseek-chat",
      inputModalities: ["text"],
      supportsHostedWebSearch: true,
      alias: "Deepseek.chat",
    },
  ],
  keys: [
    {
      name: "primary",
      weight: 2,
      enabled: true,
      alwaysTry: true,
      maskedKey: "sk-••••",
      fingerprint: "abc123",
    },
  ],
  balanceQuery: null,
}

describe("provider editor state", () => {
  test("creates independent empty drafts", () => {
    const first = createEmptyProviderDraft()
    const second = createEmptyProviderDraft()

    first.models[0].id = "changed"
    first.keys[0].name = "changed"

    expect(second.models[0].id).toBe("")
    expect(second.keys[0].name).toBe("primary")
  })

  test("converts public provider data into a safe editable draft", () => {
    const draft = providerToDraft(provider)

    expect(draft.keys[0]).toMatchObject({
      name: "primary",
      key: "",
      enabled: true,
      alwaysTry: true,
      maskedKey: "sk-••••",
    })
    expect(draft.balanceQuery).toMatchObject({
      enabled: false,
      language: "javascript",
      timeoutMs: 10000,
    })
    expect(draft.models[0].supportsHostedWebSearch).toBe(true)
    expect(draft.supportsEncryptedAgentMessages).toBe(true)

    draft.models[0].inputModalities.push("image")
    expect(provider.models[0].inputModalities).toEqual(["text"])
  })

  test("builds a persistence payload without public key metadata", () => {
    const payload = providerDraftPayload(providerToDraft(provider))
    const keys = payload.keys!

    expect(keys[0]).toEqual({
      name: "primary",
      key: "",
      weight: 2,
      enabled: true,
      alwaysTry: true,
    })
    expect(keys[0]).not.toHaveProperty("maskedKey")
    expect(keys[0]).not.toHaveProperty("fingerprint")
    expect(payload.supportsEncryptedAgentMessages).toBe(true)
  })

  test("sends the original key name only when a masked key is renamed", () => {
    const draft = providerToDraft(provider)
    draft.keys[0].name = "renamed"

    expect(providerDraftPayload(draft).keys![0]).toMatchObject({
      name: "renamed",
      originalName: "primary",
      key: "",
    })
  })

  test("omits an unchanged key snapshot from provider updates", () => {
    const baseline = providerToDraft(provider)
    const draft = providerToDraft(provider)
    draft.name = "Updated name"

    const payload = providerUpdatePayload(draft, 7, {
      baseline,
      originalBaseUrl: baseline.baseUrl,
    })

    expect(payload).not.toHaveProperty("keys")
    expect(payload).toMatchObject({ name: "Updated name", expectedRevision: 7 })

    draft.keys[0].weight = 3
    expect(
      providerUpdatePayload(draft, 7, {
        baseline,
        originalBaseUrl: baseline.baseUrl,
      })
    ).toHaveProperty("keys")
  })

  test("requires every masked secret again when the provider origin changes", () => {
    const baseline = providerToDraft(provider)
    const draft = providerToDraft(provider)
    draft.baseUrl = "https://other.example/v1"

    expect(providerOriginsDiffer(provider.baseUrl, draft.baseUrl)).toBe(true)
    expect(() =>
      providerUpdatePayload(draft, 3, {
        baseline,
        originalBaseUrl: baseline.baseUrl,
        originChangedMessage: "origin changed",
      })
    ).toThrow("origin changed")

    draft.keys[0].key = "sk-reentered"
    expect(
      providerUpdatePayload(draft, 3, {
        baseline,
        originalBaseUrl: baseline.baseUrl,
      })
    ).toMatchObject({
      expectedRevision: 3,
      keys: [{ name: "primary", key: "sk-reentered" }],
    })
  })

  test("allows masked secrets to remain blank for path changes on one origin", () => {
    const baseline = providerToDraft(provider)
    const draft = providerToDraft(provider)
    draft.baseUrl = "https://api.deepseek.com/v2"

    expect(providerOriginsDiffer(provider.baseUrl, draft.baseUrl)).toBe(false)
    expect(
      providerUpdatePayload(draft, 2, {
        baseline,
        originalBaseUrl: baseline.baseUrl,
      })
    ).not.toHaveProperty("keys")
  })

  test("adds fetched models deterministically and ignores duplicates", () => {
    const empty = createEmptyProviderDraft()
    const fetched = {
      id: "chat",
      name: "Chat",
      upstreamModel: "deepseek-chat",
      ownedBy: "deepseek",
    }
    const added = addFetchedModelToDraft(empty, fetched)

    expect(added.models).toEqual([
      {
        id: "chat",
        name: "Chat",
        upstreamModel: "deepseek-chat",
        inputModalities: ["text"],
        supportsHostedWebSearch: false,
      },
    ])
    expect(addFetchedModelToDraft(added, fetched)).toBe(added)

    const collision = addFetchedModelToDraft(added, {
      id: "chat",
      name: "Reasoner",
      upstreamModel: "deepseek-reasoner",
      ownedBy: "deepseek",
    })
    expect(collision.models[1].id).toBe("chat-2")
  })

  test("clears hosted web search when switching to Chat Completions", () => {
    const draft = providerToDraft(provider)
    const chatDraft = setProviderUpstreamFormat(draft, "chat-completions")

    expect(chatDraft.upstreamFormat).toBe("chat-completions")
    expect(chatDraft.supportsEncryptedAgentMessages).toBe(false)
    expect(chatDraft.models[0].supportsHostedWebSearch).toBe(false)
    expect(setProviderUpstreamFormat(chatDraft, "chat-completions")).toBe(
      chatDraft
    )
  })

  test("formats remaining balance and derives it from total minus used", () => {
    expect(
      balanceResultAmount(
        {
          isAvailable: true,
          items: [{ isValid: true, total: 1000, used: 250, unit: "USD" }],
        },
        "en"
      )
    ).toBe("USD 750")

    expect(balanceResultAmount({ isAvailable: true, items: [] }, "en")).toBe(
      "—"
    )
  })
})
