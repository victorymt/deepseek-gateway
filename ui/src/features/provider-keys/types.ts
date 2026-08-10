export type KeyAction =
  | "toggle"
  | "alwaysTry"
  | "test"
  | "balance"
  | "weight"
  | "delete"

export type KeyFeedback = { kind: "success" | "error"; message: string } | null

export type ProviderKeyCopy = {
  actionFailed: string
  balanceRefreshed: string
  cancel: string
  deleteKey: string
  deleteKeyDescription: (name: string) => string
  deleteKeyTitle: string
  disabledProvider: string
  editWeight: string
  enabledProvider: string
  granted: string
  keyConnected: (status: number, latencyMs: number) => string
  keyDeleted: string
  keyDisabled: string
  keyEnabled: string
  alwaysTry: string
  alwaysTryDescription: string
  keyUpdated: string
  lastEnabledKey: string
  providerSummary: (keys: number, requests: number) => string
  saveWeight: string
  testKey: string
  refreshBalance: string
  topUp: string
  total: string
  used: string
  unavailable: string
  weight: string
  weightInvalid: string
  columns: {
    balance: string
    cooldown: string
    errors: string
    failures: string
    inFlight: string
    lastUsed: string
    rateLimited: string
    requests: string
    success: string
  }
  states: {
    cooldown: string
    disabled: string
    healthy: string
    invalid: string
    unhealthy: string
  }
}

export type KeyTestResult = {
  ok: boolean
  status: number
  latencyMs: number
}
