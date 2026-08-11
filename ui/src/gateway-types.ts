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
  alias: string
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
  enabled: boolean
  models: ProviderModel[]
  keys: MaskedProviderKey[]
  balanceQuery: BalanceQuery | null
}

export type ProviderConfig = {
  schemaVersion: number
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
  authRequired: boolean
  envKey: string | null
  defaultModel: string
  gatewayUrl: string
  modelsPath: string
  configToml: string
  catalogJson: string
}
