import { useId } from "react"
import {
  CircleDotIcon,
  PlugZapIcon,
  RefreshCwIcon,
  Repeat2Icon,
  Trash2Icon,
} from "lucide-react"

import type { Locale } from "@/components/language-provider"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { GatewayKey } from "@/gateway-types"
import { formatNumber } from "@/lib/format-number"

import { EditWeightDialog } from "./edit-weight-dialog"
import { KeyBalance } from "./key-balance"
import type { KeyFeedback, ProviderKeyCopy } from "./types"
import { useKeyActions } from "./use-key-actions"

function StatusBadge({
  keyInfo,
  copy,
}: {
  keyInfo: GatewayKey
  copy: ProviderKeyCopy
}) {
  const translatedState =
    copy.states[keyInfo.state as keyof ProviderKeyCopy["states"]] ??
    keyInfo.state
  const variant =
    keyInfo.state === "invalid" || keyInfo.state === "unhealthy"
      ? "destructive"
      : keyInfo.state === "healthy"
        ? "secondary"
        : "outline"

  return (
    <Badge variant={variant}>
      <CircleDotIcon data-icon="inline-start" />
      {translatedState}
    </Badge>
  )
}

export function KeyCard({
  providerId,
  keyInfo,
  balanceQueryEnabled,
  locale,
  copy,
  cannotDisable,
  cannotDelete,
  onRefresh,
  onFeedback,
}: {
  providerId: string
  keyInfo: GatewayKey
  balanceQueryEnabled: boolean
  locale: Locale
  copy: ProviderKeyCopy
  cannotDisable: boolean
  cannotDelete: boolean
  onRefresh: () => Promise<void>
  onFeedback: (feedback: KeyFeedback) => void
}) {
  const switchId = useId()
  const alwaysTryId = useId()
  const enabled = keyInfo.enabled !== false
  const {
    pending,
    refreshBalance,
    remove,
    setAlwaysTry,
    test,
    toggle,
    updateWeight,
  } = useKeyActions({
      providerId,
      keyName: keyInfo.name,
      copy,
      onRefresh,
      onFeedback,
    })
  const metrics = [
    [copy.columns.requests, keyInfo.total],
    [copy.columns.success, keyInfo.success],
    [copy.columns.errors, keyInfo.errors],
    [copy.columns.rateLimited, keyInfo.ratelimited],
    [copy.columns.inFlight, keyInfo.inFlight],
    [copy.columns.failures, keyInfo.failureCount],
  ] as const

  return (
    <Card size="sm" className="min-h-80">
      <CardHeader>
        <CardTitle className="font-mono">{keyInfo.name}</CardTitle>
        <CardDescription>
          {copy.weight} {keyInfo.weight}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          {keyInfo.alwaysTry && (
            <Badge variant="outline" title={copy.alwaysTryDescription}>
              <Repeat2Icon data-icon="inline-start" />
              {copy.alwaysTry}
            </Badge>
          )}
          <StatusBadge keyInfo={keyInfo} copy={copy} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-5">
        <KeyBalance keyInfo={keyInfo} locale={locale} copy={copy} />
        <div className="grid grid-cols-3 gap-x-4 gap-y-4">
          {metrics.map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col gap-1">
              <p
                className="truncate text-xs text-muted-foreground"
                title={label}
              >
                {label}
              </p>
              <p className="font-mono text-base font-medium tabular-nums">
                {formatNumber(value, locale)}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            {copy.columns.cooldown}{" "}
            <span className="font-mono text-foreground">
              {keyInfo.cooldownSec ? `${keyInfo.cooldownSec}s` : "—"}
            </span>
          </span>
          <span className="text-muted-foreground">
            {copy.columns.lastUsed}{" "}
            <span className="font-mono text-foreground">
              {keyInfo.lastUsed
                ? new Date(keyInfo.lastUsed).toLocaleTimeString(locale)
                : "—"}
            </span>
          </span>
        </div>
        {keyInfo.lastError && (
          <p
            className="truncate text-xs text-destructive"
            title={keyInfo.lastError}
          >
            {keyInfo.lastError}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Field orientation="horizontal" className="w-auto gap-2">
              <Switch
                id={switchId}
                size="sm"
                checked={enabled}
                disabled={pending !== null || cannotDisable}
                aria-label={enabled ? copy.keyEnabled : copy.keyDisabled}
                title={cannotDisable ? copy.lastEnabledKey : undefined}
                onCheckedChange={(checked) => void toggle(checked)}
              />
              <FieldLabel htmlFor={switchId}>
                {enabled ? copy.keyEnabled : copy.keyDisabled}
              </FieldLabel>
            </Field>
            <Field orientation="horizontal" className="w-auto gap-2">
              <Switch
                id={alwaysTryId}
                size="sm"
                checked={keyInfo.alwaysTry}
                disabled={pending !== null}
                aria-label={copy.alwaysTry}
                title={copy.alwaysTryDescription}
                onCheckedChange={(checked) => void setAlwaysTry(checked)}
              />
              <FieldLabel
                htmlFor={alwaysTryId}
                title={copy.alwaysTryDescription}
              >
                {copy.alwaysTry}
              </FieldLabel>
            </Field>
          </div>
          <div className="flex items-center gap-1">
            {balanceQueryEnabled && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copy.refreshBalance}
                title={copy.refreshBalance}
                disabled={pending !== null}
                onClick={() => void refreshBalance()}
              >
                {pending === "balance" ? <Spinner /> : <RefreshCwIcon />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={copy.testKey}
              title={copy.testKey}
              disabled={pending !== null}
              onClick={() => void test()}
            >
              {pending === "test" ? <Spinner /> : <PlugZapIcon />}
            </Button>
            <EditWeightDialog
              providerId={providerId}
              keyName={keyInfo.name}
              weight={keyInfo.weight}
              copy={copy}
              disabled={pending !== null}
              pending={pending === "weight"}
              onSubmit={updateWeight}
            />
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={copy.deleteKey}
                    title={cannotDelete ? copy.lastEnabledKey : copy.deleteKey}
                    disabled={pending !== null || cannotDelete}
                  />
                }
              >
                <Trash2Icon />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.deleteKeyTitle}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {copy.deleteKeyDescription(keyInfo.name)}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    {copy.deleteKey}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </CardFooter>
    </Card>
  )
}
