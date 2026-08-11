import type { BalanceQuery, BalanceResult, Provider } from "@/gateway-types"

export type InputModality = "text" | "image"

export type ModelDraft = {
  id: string
  name: string
  upstreamModel: string
  inputModalities: InputModality[]
  supportsHostedWebSearch: boolean
}

export type FetchedModel = Omit<
  ModelDraft,
  "inputModalities" | "supportsHostedWebSearch"
> & {
  ownedBy: string | null
}

export type KeyDraft = {
  name: string
  originalName?: string
  key: string
  weight: number
  enabled: boolean
  alwaysTry: boolean
  maskedKey?: string
  fingerprint?: string
}

export type ProviderDraft = {
  id: string
  name: string
  baseUrl: string
  upstreamFormat: "responses" | "chat-completions"
  enabled: boolean
  models: ModelDraft[]
  keys: KeyDraft[]
  balanceQuery: BalanceQuery
}

type ProviderDraftPayloadOptions = {
  baseline?: ProviderDraft | null
  originalBaseUrl?: string
  originChangedMessage?: string
}

export const DEEPSEEK_BALANCE_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function(response) {
    return (response.balance_infos || []).map(function(info) {
      return {
        planName: String(info.currency || ""),
        remaining: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        unit: String(info.currency || ""),
        isValid: response.is_available !== false
      };
    });
  }
})`

export const OPENROUTER_BALANCE_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/key",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "Accept": "application/json"
    }
  },
  extractor: function(response) {
    const data = response.data || {};
    const total = data.limit == null ? undefined : Number(data.limit);
    const used = data.usage == null ? undefined : Number(data.usage);
    const remaining = data.limit_remaining == null
      ? (total == null || used == null ? undefined : total - used)
      : Number(data.limit_remaining);
    return {
      planName: data.is_free_tier ? "Free" : "OpenRouter",
      remaining: remaining,
      used: used,
      total: total,
      unit: "USD",
      isValid: Boolean(response.data)
    };
  }
})`

export function createEmptyProviderDraft(): ProviderDraft {
  return {
    id: "",
    name: "",
    baseUrl: "https://",
    upstreamFormat: "responses",
    enabled: true,
    models: [
      {
        id: "",
        name: "",
        upstreamModel: "",
        inputModalities: ["text"],
        supportsHostedWebSearch: false,
      },
    ],
    keys: [
      {
        name: "primary",
        key: "",
        weight: 1,
        enabled: true,
        alwaysTry: false,
      },
    ],
    balanceQuery: {
      enabled: false,
      language: "javascript",
      code: "",
      timeoutMs: 10000,
    },
  }
}

export function providerToDraft(provider: Provider): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    upstreamFormat: provider.upstreamFormat,
    enabled: provider.enabled,
    models: provider.models.map(
      ({
        id,
        name,
        upstreamModel,
        inputModalities,
        supportsHostedWebSearch,
      }) => ({
        id,
        name,
        upstreamModel,
        inputModalities: [...inputModalities],
        supportsHostedWebSearch,
      })
    ),
    keys: provider.keys.map((key) => ({
      ...key,
      originalName: key.name,
      key: "",
      enabled: key.enabled !== false,
      alwaysTry: key.alwaysTry === true,
    })),
    balanceQuery: provider.balanceQuery ?? {
      enabled: false,
      language: "javascript",
      code: "",
      timeoutMs: 10000,
    },
  }
}

function persistedKeyDraft(key: KeyDraft) {
  return {
    name: key.name,
    originalName: key.originalName,
    key: key.key,
    weight: key.weight,
    enabled: key.enabled,
    alwaysTry: key.alwaysTry,
  }
}

export function providerOriginsDiffer(left: string, right: string) {
  if (!left || !right) return false
  try {
    return new URL(left).origin !== new URL(right).origin
  } catch {
    return true
  }
}

export function providerDraftKeysChanged(
  draft: ProviderDraft,
  baseline?: ProviderDraft | null
) {
  if (!baseline) return true
  return (
    JSON.stringify(draft.keys.map(persistedKeyDraft)) !==
    JSON.stringify(baseline.keys.map(persistedKeyDraft))
  )
}

export function providerDraftPayload(
  draft: ProviderDraft,
  options: ProviderDraftPayloadOptions = {}
) {
  const provider = {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    upstreamFormat: draft.upstreamFormat,
    enabled: draft.enabled,
    models: draft.models,
    balanceQuery: draft.balanceQuery,
  }
  const originChanged = providerOriginsDiffer(
    options.originalBaseUrl || "",
    draft.baseUrl
  )
  if (
    originChanged &&
    draft.keys.some((key) => key.maskedKey && !key.key.trim())
  ) {
    throw new Error(
      options.originChangedMessage ||
        "Re-enter every existing API key when changing the provider origin."
    )
  }

  const includeKeys =
    originChanged || providerDraftKeysChanged(draft, options.baseline)
  return {
    ...provider,
    ...(includeKeys
      ? {
          keys: draft.keys.map(
            ({ name, originalName, key, weight, enabled, alwaysTry }) => ({
              name,
              ...(originalName && originalName !== name
                ? { originalName }
                : {}),
              key,
              weight,
              enabled,
              alwaysTry,
            })
          ),
        }
      : {}),
  }
}

export function providerUpdatePayload(
  draft: ProviderDraft,
  expectedRevision: number,
  options: ProviderDraftPayloadOptions = {}
) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("A valid provider revision is required before saving.")
  }
  return {
    ...providerDraftPayload(draft, options),
    expectedRevision,
  }
}

export function addFetchedModelToDraft(
  draft: ProviderDraft,
  model: FetchedModel
): ProviderDraft {
  if (draft.models.some((item) => item.upstreamModel === model.upstreamModel)) {
    return draft
  }

  const usedIds = new Set(draft.models.map((item) => item.id))
  let id = model.id
  let suffix = 2
  while (usedIds.has(id)) {
    const tail = `-${suffix++}`
    id = `${model.id.slice(0, 63 - tail.length)}${tail}`
  }

  const nextModel: ModelDraft = {
    id,
    name: model.name,
    upstreamModel: model.upstreamModel,
    inputModalities: ["text"],
    supportsHostedWebSearch: false,
  }
  const hasOnlyEmptyModel =
    draft.models.length === 1 &&
    !draft.models[0].id &&
    !draft.models[0].name &&
    !draft.models[0].upstreamModel

  return {
    ...draft,
    models: hasOnlyEmptyModel ? [nextModel] : [...draft.models, nextModel],
  }
}

export function setProviderUpstreamFormat(
  draft: ProviderDraft,
  upstreamFormat: ProviderDraft["upstreamFormat"]
): ProviderDraft {
  if (draft.upstreamFormat === upstreamFormat) return draft
  return {
    ...draft,
    upstreamFormat,
    models:
      upstreamFormat === "chat-completions"
        ? draft.models.map((model) => ({
            ...model,
            supportsHostedWebSearch: false,
          }))
        : draft.models,
  }
}

export function balanceResultAmount(
  result: BalanceResult,
  locale: string
): string {
  const first = result.items[0]
  const remaining =
    first?.remaining ??
    (first?.total !== undefined && first?.used !== undefined
      ? first.total - first.used
      : undefined)

  return `${first?.unit ? `${first.unit} ` : ""}${
    remaining === undefined ? "—" : remaining.toLocaleString(locale)
  }`
}
