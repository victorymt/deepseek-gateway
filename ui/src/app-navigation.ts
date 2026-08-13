export type Section =
  | "dashboard"
  | "providers"
  | "settings"
  | "codex"
  | "models"
  | "agents"
  | "logs"
  | "usage"
  | "storage"
  | "integrations"

const sections = new Set<Section>([
  "dashboard",
  "providers",
  "settings",
  "codex",
  "models",
  "agents",
  "logs",
  "usage",
  "storage",
  "integrations",
])

export function sectionFromHash(hash: string): Section {
  const value = hash.replace(/^#\/?/, "").replace(/^operations\//, "")
  return sections.has(value as Section) ? (value as Section) : "providers"
}

export function sectionHash(section: Section): string {
  return `#${section}`
}

export function isOperationsSection(section: Section): boolean {
  return [
    "models",
    "agents",
    "logs",
    "usage",
    "storage",
    "integrations",
  ].includes(section)
}
