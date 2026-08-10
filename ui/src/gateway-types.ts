export type BalanceInfo = {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export type GatewayKey = {
  name: string
  weight: number
  enabled: boolean
  state: "healthy" | "cooldown" | "invalid" | string
  invalid: boolean
  lastError: string
  balance?: { infos: BalanceInfo[]; isAvailable: boolean }
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
  enabled: boolean
  modelCount: number
  total: Health["total"]
  keys: GatewayKey[]
}

export type Health = {
  status: string
  version: string
  mock: boolean
  upstream: string
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
  alias: string
}

export type MaskedProviderKey = {
  name: string
  weight: number
  enabled: boolean
  maskedKey: string
  fingerprint: string
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  models: ProviderModel[]
  keys: MaskedProviderKey[]
}

export type ProviderConfig = {
  schemaVersion: number
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
}

export type GatewaySettingField = Exclude<
  keyof GatewaySettingValues,
  "tokenConfigured"
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
  envKey: string
  defaultModel: string
  gatewayUrl: string
  modelsPath: string
  configToml: string
  catalogJson: string
}
