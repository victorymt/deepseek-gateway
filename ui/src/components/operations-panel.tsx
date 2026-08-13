import {
  Component,
  lazy,
  Suspense,
  type ComponentType,
  type ErrorInfo,
  type LazyExoticComponent,
  type ReactNode,
} from "react"
import { RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import type {
  OperationsHealth,
  OperationsKind,
  OperationsPageProps,
} from "./operations/types"
import type { Locale } from "./language-provider"

const pages: Record<
  OperationsKind,
  LazyExoticComponent<ComponentType<OperationsPageProps>>
> = {
  models: lazy(() => import("./operations/models-page")),
  agents: lazy(() => import("./operations/agents-page")),
  logs: lazy(() => import("./operations/logs-page")),
  usage: lazy(() => import("./operations/usage-page")),
  storage: lazy(() => import("./operations/storage-page")),
  integrations: lazy(() => import("./operations/integrations-page")),
}

const operationsKinds: OperationsKind[] = [
  "models",
  "agents",
  "logs",
  "usage",
  "storage",
  "integrations",
]

export class OperationsPageErrorBoundary extends Component<
  { locale: Locale; children: ReactNode; reload?: () => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Failed to load operations page", error, info)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const zh = this.props.locale === "zh-CN"
    return (
      <section className="operations-panel">
        <Alert variant="destructive">
          <AlertTitle>{zh ? "页面加载失败" : "Page failed to load"}</AlertTitle>
          <AlertDescription>
            <span>
              {zh
                ? "无法加载当前运维页面，请重新加载应用后重试。"
                : "The operations page could not be loaded. Reload the app to try again."}
            </span>
            <Button
              variant="outline"
              onClick={() =>
                (this.props.reload || (() => window.location.reload()))()
              }
            >
              <RefreshCwIcon data-icon="inline-start" />
              {zh ? "重新加载" : "Reload"}
            </Button>
          </AlertDescription>
        </Alert>
      </section>
    )
  }
}

function OperationsPageFallback() {
  return (
    <section className="operations-panel" aria-busy="true">
      <div className="operations-header">
        <div className="operation-stack">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-64 w-full" />
    </section>
  )
}

type OperationsPanelProps = {
  kind: OperationsKind
  locale: Locale
  health: OperationsHealth
  onDirtyChange?: (source: string, dirty: boolean) => void
}

export class OperationsPanel extends Component<
  OperationsPanelProps,
  { visited: Set<OperationsKind> }
> {
  state = { visited: new Set<OperationsKind>([this.props.kind]) }
  private readonly dirtyHandlers = Object.fromEntries(
    operationsKinds.map((pageKind) => [
      pageKind,
      (dirty: boolean) => this.props.onDirtyChange?.(pageKind, dirty),
    ])
  ) as Record<OperationsKind, (dirty: boolean) => void>

  static getDerivedStateFromProps(
    props: OperationsPanelProps,
    state: { visited: Set<OperationsKind> }
  ) {
    if (state.visited.has(props.kind)) return null
    const visited = new Set(state.visited)
    visited.add(props.kind)
    return { visited }
  }

  render() {
    const { kind, locale, health } = this.props
    return (
      <>
        {operationsKinds.map((pageKind) => {
          if (!this.state.visited.has(pageKind)) return null
          const Page = pages[pageKind]
          const active = pageKind === kind
          return (
            <div
              key={pageKind}
              hidden={!active}
              aria-hidden={!active || undefined}
            >
              <OperationsPageErrorBoundary locale={locale}>
                <Suspense fallback={<OperationsPageFallback />}>
                  <Page
                    locale={locale}
                    health={health}
                    active={active}
                    onDirtyChange={this.dirtyHandlers[pageKind]}
                  />
                </Suspense>
              </OperationsPageErrorBoundary>
            </div>
          )
        })}
      </>
    )
  }
}
