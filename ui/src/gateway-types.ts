export type BalanceQuery = {
  enabled: boolean
  language: "javascript"
  code: string
  timeoutMs: number
  refreshMs?: number
}

export type BalanceItem = {
  planName?: string
  extra?: string
  isValid: boolean
  invalidMessage?: string
  total?: number
  used?: number
  remaining?: number
  granted?: number
  toppedUp?: number
  unit?: string
}

export type BalanceResult = {
  isAvailable: boolean
  items: BalanceItem[]
}

export type GatewayKey = {
  name: string
  weight: number
  enabled: boolean
  alwaysTry: boolean
  state: "healthy" | "cooldown" | "invalid" | "unhealthy" | string
  invalid: boolean
  unhealthy: boolean
  lastError: string
  balance?: BalanceResult
  balanceError: string
  inFlight: number
  total: number
  success: number
  errors: number
  ratelimited: number
  failureCount: number
  cooldownSec: number
  lastUsed: string | null
  balanceUpdatedAt: string | null
}

export type ProviderHealth = {
  id: string
  name: string
  baseUrl: string
  upstreamFormat: "responses" | "chat-completions"
  enabled: boolean
  balanceQueryEnabled: boolean
  modelCount: number
  total: Health["total"]
  keys: GatewayKey[]
}

export type Health = {
  status: string
  setupRequired: boolean
  version: string
  mock: boolean
  upstream: string | null
  defaultProvider: string
  defaultModel: string
  port: number
  uptime: number
  total: {
    requests: number
    success: number
    errors: number
    ratelimited: number
    tokens: number
  }
  keys: GatewayKey[]
  providers: ProviderHealth[]
}

export type ProviderModel = {
  id: string
  name: string
  upstreamModel: string
  inputModalities: Array<"text" | "image">
  supportsHostedWebSearch: boolean
  supportsCustomApplyPatch: boolean
  contextWindow?: number
  supportsParallelToolCalls?: boolean
  baseInstructions?: string
  reasoning?: ReasoningConfig | null
  alias: string
}

export type ModelCapabilityCatalog = {
  schemaVersion: number
  unknownModel: {
    inputModalities: Array<"text" | "image">
  }
  models: Array<{
    id: string
    inputModalities: Array<"text" | "image">
    supportsHostedWebSearch?: boolean
    supportsCustomApplyPatch?: boolean
    reasoning?: ModelCapabilityReasoningConfig
  }>
}

export type ModelCapabilityReasoningConfig = {
  parameter: "reasoning_effort"
  default: string
  levels: Array<{
    effort: string
    description?: string
  }>
}

export type ReasoningParameter =
  | "reasoning_effort"
  | "enable_thinking"
  | "thinking_budget"

export type ReasoningLevel = {
  effort: string
  description?: string
  upstreamValue?: string | number | boolean
}

export type ReasoningConfig = {
  parameter: ReasoningParameter
  default: string
  levels: ReasoningLevel[]
}

export type MaskedProviderKey = {
  name: string
  weight: number
  enabled: boolean
  alwaysTry: boolean
  maskedKey: string
  fingerprint: string
}

export type KeyImportResult = {
  addedCount: number
  ignoredCount: number
  ignored: Array<{
    entry: number
    name: string | null
    reason: string
  }>
  totalCount: number
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  upstreamFormat: "responses" | "chat-completions"
  apiProfile: "generic" | "deepseek"
  supportsEncryptedAgentMessages: boolean
  supportsPromptCacheKey: boolean
  keyRouting: "balanced" | "prompt-cache-affinity"
  enabled: boolean
  models: ProviderModel[]
  keys: MaskedProviderKey[]
  balanceQuery: BalanceQuery | null
}

export type ProviderConfig = {
  schemaVersion: number
  revision: number
  setupPending: boolean
  defaultProvider: string
  defaultModel: string
  providers: Provider[]
}

export type GatewaySettingValues = {
  port: number
  host: string
  cooldownMs: number
  blacklistThreshold: number
  balanceRefreshMs: number
  maxRetries: number
  timeoutMs: number
  maxBodyBytes: number
  tokenConfigured: boolean
  adminTokenConfigured: boolean
}

export type GatewaySettingField = Exclude<
  keyof GatewaySettingValues,
  "tokenConfigured" | "adminTokenConfigured"
>

export type GatewaySettings = {
  writable: boolean
  persisted: GatewaySettingValues
  effective: GatewaySettingValues
  overrides: Partial<Record<GatewaySettingField | "token", string>>
  restartRequired: Array<"host" | "port">
}

export type CodexArtifacts = {
  providerId: string
  revision: string
  authRequired: boolean
  envKey: string | null
  defaultModel: string
  gatewayUrl: string
  modelsPath: string
  configToml: string
  catalogJson: string
}

export type GatewayLogEntry = {
  id: string
  timestamp: number
  level: string
  message: string
  method?: string
  route?: string
  status?: number
  provider?: string
  model?: string
  latencyMs?: number
}

export type LogsPage = {
  logs: GatewayLogEntry[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

export type UsageTotals = Health["total"]

export type UsagePoint = UsageTotals & {
  date: string
  providers: Record<string, UsageTotals>
  models: Record<string, UsageTotals>
}

export type UsageResponse = {
  range: string
  total: UsageTotals
  points: UsagePoint[]
  providers: Record<string, UsageTotals>
  models: Record<string, UsageTotals>
}

export type StorageBackup = {
  id: string
  path: string
  createdAt: number
  size: number
}

export type StorageInfo = {
  configPath: string
  configExists: boolean
  configSize: number
  operationsPath: string
  schemaVersion: number
  backups: StorageBackup[]
  retention: { logsDays: number; usageDays: number; backupLimit: number }
}

export type Integration = {
  id: string
  name: string
  type: string
  baseUrl: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type Subagent = {
  id: string
  name: string
  description: string
  providerId: string
  model: string
  developerInstructions: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  projection: {
    codexHome: string
    path: string | null
    installed: boolean
    status: "installed" | "disabled" | "missing" | "modified" | "unmanaged" | "unavailable"
    backupPath: string | null
  }
}
