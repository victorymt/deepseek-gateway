import type { Locale } from "@/components/language-provider"

export type OperationsKind =
  "models" | "agents" | "logs" | "usage" | "storage" | "integrations"

export type OperationsHealth = {
  providers: Array<{
    id: string
    name: string
    modelCount: number
    total: { requests: number; tokens: number }
    keys: unknown[]
  }>
  defaultModel: string
} | null

export type OperationsPageProps = {
  locale: Locale
  health: OperationsHealth
  active: boolean
}

export type IntegrationDraft = {
  id?: string
  name: string
  type: string
  baseUrl: string
  enabled: boolean
}

export type SubagentDraft = {
  id?: string
  name: string
  description: string
  providerId: string
  model: string
  developerInstructions: string
  enabled: boolean
}
