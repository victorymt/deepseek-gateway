import { Badge } from "@/components/ui/badge"
import type { GatewayKey } from "@/gateway-types"

import type { ProviderKeyCopy } from "./types"

export function KeyBalance({
  keyInfo,
  copy,
}: {
  keyInfo: GatewayKey
  copy: ProviderKeyCopy
}) {
  const infos = keyInfo.balance?.infos ?? []

  if (!infos.length) {
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
        {infos.map((info) => (
          <div
            key={`${keyInfo.name}-${info.currency}`}
            className="flex flex-col gap-1"
          >
            <p className="font-mono text-2xl font-semibold tabular-nums">
              <span className="mr-2 text-sm font-medium text-muted-foreground">
                {info.currency}
              </span>
              {info.totalBalance}
            </p>
            <p className="text-xs text-muted-foreground">
              {copy.topUp} {info.toppedUpBalance} · {copy.granted}{" "}
              {info.grantedBalance}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
