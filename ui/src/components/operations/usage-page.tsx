import { useCallback, useState } from "react"
import { ChartNoAxesCombinedIcon, DownloadIcon } from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { UsageResponse } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { downloadCsv } from "./csv-download"
import { OperationsPageShell } from "./page-shell"
import { useOperationsAutoRefresh, useOperationsPage } from "./page-state"
import type { OperationsPageProps } from "./types"

export default function UsagePage({ locale, active }: OperationsPageProps) {
  const zh = locale === "zh-CN"
  const [range, setRange] = useState("30d")
  const [refreshSeconds, setRefreshSeconds] = useState(0)
  const load = useCallback(
    (signal: AbortSignal) =>
      apiRequest<UsageResponse>(`/api/usage?range=${range}`, { signal }),
    [range]
  )
  const page = useOperationsPage<UsageResponse | null>(load, active, null)
  const usage = page.data
  useOperationsAutoRefresh(page.refresh, refreshSeconds, false, active)
  const hasUsageData = Boolean(
    usage && Object.values(usage.total).some((value) => Number(value) > 0)
  )

  return (
    <OperationsPageShell
      kind="usage"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
      refreshSeconds={refreshSeconds}
      onRefreshSecondsChange={setRefreshSeconds}
    >
      {usage && (
        <Card>
          <CardHeader>
            <div className="operation-row">
              <CardTitle>{zh ? "用量趋势" : "Usage trend"}</CardTitle>
              <div className="range-buttons">
                {["24h", "7d", "30d"].map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={range === value ? "default" : "outline"}
                    onClick={() => setRange(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="usage-total-grid">
              {Object.entries(usage.total).map(([key, value]) => (
                <div key={key}>
                  <span>{key}</span>
                  <strong>{Number(value).toLocaleString(locale)}</strong>
                </div>
              ))}
            </div>
            {hasUsageData ? (
              <>
                <div className="usage-chart">
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={usage.points}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="requests"
                        stroke="#248d70"
                        strokeWidth={2}
                        name={zh ? "请求" : "Requests"}
                      />
                      <Line
                        type="monotone"
                        dataKey="tokens"
                        stroke="#e29b42"
                        strokeWidth={2}
                        name={zh ? "令牌" : "Tokens"}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="usage-breakdown-grid">
                  <div>
                    <h3>{zh ? "按 Provider" : "By provider"}</h3>
                    {Object.entries(usage.providers ?? {}).map(
                      ([name, values]) => (
                        <div className="usage-breakdown-row" key={name}>
                          <span>{name}</span>
                          <strong>
                            {values.requests.toLocaleString(locale)} req ·{" "}
                            {values.tokens.toLocaleString(locale)} tok
                          </strong>
                        </div>
                      )
                    )}
                  </div>
                  <div>
                    <h3>{zh ? "按模型" : "By model"}</h3>
                    {Object.entries(usage.models ?? {}).map(
                      ([name, values]) => (
                        <div className="usage-breakdown-row" key={name}>
                          <span>{name}</span>
                          <strong>
                            {values.requests.toLocaleString(locale)} req ·{" "}
                            {values.tokens.toLocaleString(locale)} tok
                          </strong>
                        </div>
                      )
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadCsv(
                      `gateway-usage-${usage.range}.csv`,
                      [
                        "date",
                        "requests",
                        "success",
                        "errors",
                        "ratelimited",
                        "tokens",
                      ],
                      usage.points.map((point) => [
                        point.date,
                        point.requests,
                        point.success,
                        point.errors,
                        point.ratelimited,
                        point.tokens,
                      ])
                    )
                  }
                >
                  <DownloadIcon data-icon="inline-start" />
                  {zh ? "导出 CSV" : "Export CSV"}
                </Button>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ChartNoAxesCombinedIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {zh ? "暂无用量数据" : "No usage data"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {zh
                      ? "所选时间范围内还没有 Gateway 请求。"
                      : "No gateway requests were recorded in the selected range."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      )}
    </OperationsPageShell>
  )
}
