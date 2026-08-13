import type {
  BalanceQuery,
  BalanceResult,
  ModelCapabilityCatalog,
  Provider,
  ReasoningConfig,
} from "@/gateway-types"

export type InputModality = "text" | "image"

export type ModelDraft = {
  id: string
  name: string
  upstreamModel: string
  inputModalities: InputModality[]
  supportsHostedWebSearch: boolean
  supportsCustomApplyPatch: boolean
  reasoning?: ReasoningConfig | null
}

export type FetchedModel = Omit<
  ModelDraft,
  "supportsHostedWebSearch" | "supportsCustomApplyPatch"
> & {
  ownedBy: string | null
  capabilitySource: "upstream" | "registry" | "default"
}

export type ModelCapabilityPreset = Pick<
  ModelDraft,
  | "inputModalities"
  | "supportsHostedWebSearch"
  | "supportsCustomApplyPatch"
  | "reasoning"
>

const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  parameter: "reasoning_effort",
  default: "medium",
  levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
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
  apiProfile: "generic" | "deepseek"
  supportsEncryptedAgentMessages: boolean
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
    apiProfile: "generic",
    supportsEncryptedAgentMessages: false,
    enabled: true,
    models: [
      {
        id: "",
        name: "",
        upstreamModel: "",
        inputModalities: ["text"],
        supportsHostedWebSearch: false,
        supportsCustomApplyPatch: false,
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
    apiProfile: provider.apiProfile,
    supportsEncryptedAgentMessages:
      provider.supportsEncryptedAgentMessages === true,
    enabled: provider.enabled,
    models: provider.models.map(
      ({
        id,
        name,
        upstreamModel,
        inputModalities,
        supportsHostedWebSearch,
        supportsCustomApplyPatch,
        reasoning,
      }) => ({
        id,
        name,
        upstreamModel,
        inputModalities: [...inputModalities],
        supportsHostedWebSearch,
        supportsCustomApplyPatch,
        ...(reasoning === undefined
          ? {}
          : { reasoning: cloneReasoningConfig(reasoning) }),
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
    apiProfile: draft.apiProfile,
    supportsEncryptedAgentMessages: draft.supportsEncryptedAgentMessages,
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
  model: FetchedModel,
  catalog: ModelCapabilityCatalog | null = null
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

  const preset = inferModelCapabilityPreset(model.upstreamModel, catalog)
  const toolDefaults = providerToolDefaults(draft, preset)
  const nextModel: ModelDraft = {
    id,
    name: model.name,
    upstreamModel: model.upstreamModel,
    inputModalities: [...model.inputModalities],
    supportsHostedWebSearch: toolDefaults.supportsHostedWebSearch,
    supportsCustomApplyPatch: toolDefaults.supportsCustomApplyPatch,
    ...(model.reasoning === undefined
      ? {}
      : { reasoning: cloneReasoningConfig(model.reasoning) }),
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

function normalizeCapabilityModelId(value: string) {
  return value
    .trim()
    .replace(/^models\//i, "")
    .replace(/\[1m\]$/i, "")
    .trim()
    .toLowerCase()
}

export function inferModelInputModalities(
  upstreamModel: string,
  catalog: ModelCapabilityCatalog | null
): InputModality[] {
  return inferModelCapabilityPreset(upstreamModel, catalog).inputModalities
}

export function inferModelCapabilityPreset(
  upstreamModel: string,
  catalog: ModelCapabilityCatalog | null
): ModelCapabilityPreset {
  if (!upstreamModel.trim() || !catalog) {
    return {
      inputModalities: ["text"],
      supportsHostedWebSearch: false,
      supportsCustomApplyPatch: false,
    }
  }
  const normalized = normalizeCapabilityModelId(upstreamModel)
  const tail = normalized.split("/").at(-1)
  const match = catalog.models.find((entry) => {
    const candidate = normalizeCapabilityModelId(entry.id)
    return candidate === normalized || candidate === tail
  })
  return {
    inputModalities: [
      ...(match?.inputModalities ?? catalog.unknownModel.inputModalities),
    ],
    supportsHostedWebSearch: match?.supportsHostedWebSearch === true,
    supportsCustomApplyPatch: match?.supportsCustomApplyPatch === true,
    ...(match?.reasoning
      ? { reasoning: cloneReasoningConfig(match.reasoning) }
      : {}),
  }
}

export function modelDraftForUpstreamModel(
  model: ModelDraft,
  upstreamModel: string,
  catalog: ModelCapabilityCatalog | null,
  provider: Pick<ProviderDraft, "apiProfile" | "upstreamFormat"> = {
    apiProfile: "generic",
    upstreamFormat: "responses",
  }
): ModelDraft {
  const previousPreset = inferModelCapabilityPreset(
    model.upstreamModel,
    catalog
  )
  const nextPreset = inferModelCapabilityPreset(upstreamModel, catalog)
  const shouldApplyReasoning =
    model.reasoning === undefined ||
    reasoningConfigsEqual(model.reasoning, previousPreset.reasoning)
  const previousTools = providerToolDefaults(provider, previousPreset)
  const nextTools = providerToolDefaults(provider, nextPreset)

  return {
    ...model,
    upstreamModel,
    inputModalities: nextPreset.inputModalities,
    supportsHostedWebSearch:
      model.supportsHostedWebSearch === previousTools.supportsHostedWebSearch
        ? nextTools.supportsHostedWebSearch
        : model.supportsHostedWebSearch,
    supportsCustomApplyPatch:
      model.supportsCustomApplyPatch === previousTools.supportsCustomApplyPatch
        ? nextTools.supportsCustomApplyPatch
        : model.supportsCustomApplyPatch,
    ...(shouldApplyReasoning
      ? nextPreset.reasoning === undefined
        ? { reasoning: undefined }
        : { reasoning: nextPreset.reasoning }
      : {}),
  }
}

export function enabledModelReasoning(
  model: ModelDraft,
  catalog: ModelCapabilityCatalog | null
): ReasoningConfig {
  if (model.reasoning) return cloneReasoningConfig(model.reasoning)
  return (
    inferModelCapabilityPreset(model.upstreamModel, catalog).reasoning ??
    cloneReasoningConfig(DEFAULT_REASONING_CONFIG)
  )
}

export function modelDraftWithReasoningEnabled(
  model: ModelDraft,
  enabled: boolean,
  catalog: ModelCapabilityCatalog | null
): ModelDraft {
  return {
    ...model,
    reasoning: enabled ? enabledModelReasoning(model, catalog) : null,
  }
}

export function cloneReasoningConfig(
  reasoning: ReasoningConfig
): ReasoningConfig
export function cloneReasoningConfig(reasoning: null): null
export function cloneReasoningConfig(
  reasoning: ReasoningConfig | null
): ReasoningConfig | null
export function cloneReasoningConfig(
  reasoning: ReasoningConfig | null
): ReasoningConfig | null {
  return reasoning
    ? {
        ...reasoning,
        levels: reasoning.levels.map((level) => ({ ...level })),
      }
    : null
}

export function reasoningConfigsEqual(
  left: ReasoningConfig | null | undefined,
  right: ReasoningConfig | null | undefined
) {
  if (left === right) return true
  if (!left || !right || left.levels.length !== right.levels.length) {
    return false
  }
  return (
    left.parameter === right.parameter &&
    left.default === right.default &&
    left.levels.every((level, index) => {
      const other = right.levels[index]
      return (
        level.effort === other.effort &&
        level.description === other.description &&
        level.upstreamValue === other.upstreamValue
      )
    })
  )
}

export function setProviderUpstreamFormat(
  draft: ProviderDraft,
  upstreamFormat: ProviderDraft["upstreamFormat"],
  catalog: ModelCapabilityCatalog | null = null
): ProviderDraft {
  if (draft.upstreamFormat === upstreamFormat) return draft
  return {
    ...draft,
    upstreamFormat,
    supportsEncryptedAgentMessages:
      upstreamFormat === "chat-completions"
        ? false
        : draft.supportsEncryptedAgentMessages,
    models: draft.models.map((model) => {
      if (upstreamFormat === "chat-completions") {
        return {
          ...model,
          supportsHostedWebSearch: false,
          supportsCustomApplyPatch: false,
        }
      }
      const defaults = providerToolDefaults(
        { ...draft, upstreamFormat },
        inferModelCapabilityPreset(model.upstreamModel, catalog)
      )
      return { ...model, ...defaults }
    }),
  }
}

export function setProviderApiProfile(
  draft: ProviderDraft,
  apiProfile: ProviderDraft["apiProfile"],
  catalog: ModelCapabilityCatalog | null = null
): ProviderDraft {
  if (draft.apiProfile === apiProfile) return draft
  return {
    ...draft,
    apiProfile,
    models: draft.models.map((model) => ({
      ...model,
      ...providerToolDefaults(
        { ...draft, apiProfile },
        inferModelCapabilityPreset(model.upstreamModel, catalog)
      ),
    })),
  }
}

function providerToolDefaults(
  provider: Pick<ProviderDraft, "apiProfile" | "upstreamFormat">,
  preset: Pick<
    ModelCapabilityPreset,
    "supportsHostedWebSearch" | "supportsCustomApplyPatch"
  >
) {
  const enabled = provider.apiProfile === "deepseek"
    && provider.upstreamFormat === "responses"
  return {
    supportsHostedWebSearch: enabled && preset.supportsHostedWebSearch,
    supportsCustomApplyPatch: enabled && preset.supportsCustomApplyPatch,
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
