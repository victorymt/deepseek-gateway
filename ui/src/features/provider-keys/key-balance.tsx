import { Badge } from "@/components/ui/badge"
import type { Locale } from "@/components/language-provider"
import type { GatewayKey } from "@/gateway-types"
import { formatNumber } from "@/lib/format-number"

import type { ProviderKeyCopy } from "./types"

export function KeyBalance({
  keyInfo,
  locale,
  copy,
}: {
  keyInfo: GatewayKey
  locale: Locale
  copy: ProviderKeyCopy
}) {
  const items = keyInfo.balance?.items ?? []

  if (!items.length) {
    return (
      <div className="flex min-h-20 flex-col gap-1">
        <p className="text-xs text-muted-foreground">{copy.columns.balance}</p>
        <p className="font-mono text-2xl font-semibold tabular-nums">—</p>
        {keyInfo.balanceError && (
          <p className="line-clamp-2 text-xs text-destructive">
            {keyInfo.balanceError}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-20 flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted-foreground">{copy.columns.balance}</p>
        {!keyInfo.balance?.isAvailable && (
          <Badge variant="destructive">{copy.unavailable}</Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item, index) => {
          const remaining =
            item.remaining ??
            (item.total !== undefined && item.used !== undefined
              ? item.total - item.used
              : undefined)
          const details = [
            item.used !== undefined
              ? `${copy.used} ${formatNumber(item.used, locale)}`
              : "",
            item.total !== undefined
              ? `${copy.total} ${formatNumber(item.total, locale)}`
              : "",
            item.toppedUp !== undefined
              ? `${copy.topUp} ${formatNumber(item.toppedUp, locale)}`
              : "",
            item.granted !== undefined
              ? `${copy.granted} ${formatNumber(item.granted, locale)}`
              : "",
          ].filter(Boolean)
          return (
          <div
            key={`${keyInfo.name}-${item.planName || item.unit || index}`}
            className="flex flex-col gap-1"
          >
            {item.planName && item.planName !== item.unit && (
              <p className="truncate text-xs text-muted-foreground">
                {item.planName}
              </p>
            )}
            <p className="font-mono text-2xl font-semibold tabular-nums">
              <span className="mr-2 text-sm font-medium text-muted-foreground">
                {item.unit || ""}
              </span>
              {remaining === undefined ? "—" : formatNumber(remaining, locale)}
            </p>
            {details.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {details.join(" · ")}
              </p>
            )}
            {(item.invalidMessage || item.extra) && (
              <p
                className={
                  item.isValid ? "text-xs text-muted-foreground" : "text-xs text-destructive"
                }
              >
                {item.invalidMessage || item.extra}
              </p>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
