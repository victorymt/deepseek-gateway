import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckCircle2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  ShieldCheckIcon,
} from "lucide-react"

import type { Locale } from "@/components/language-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { GatewaySettingField, GatewaySettings } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

type Draft = Record<GatewaySettingField, string> & {
  token: string
  clearToken: boolean
}

const numberFields: GatewaySettingField[] = [
  "port",
  "cooldownMs",
  "blacklistThreshold",
  "balanceRefreshMs",
  "maxRetries",
  "timeoutMs",
  "maxBodyBytes",
]

const copy = {
  en: {
    title: "Gateway settings",
    description: "Runtime and persisted configuration",
    network: "Network",
    runtime: "Runtime policy",
    access: "Access control",
    host: "Listen host",
    port: "Listen port",
    cooldownMs: "429 cooldown (ms)",
    blacklistThreshold: "Blacklist threshold",
    balanceRefreshMs: "Balance refresh (ms)",
    maxRetries: "Maximum retries",
    timeoutMs: "Upstream timeout (ms)",
    maxBodyBytes: "Maximum body size (bytes)",
    token: "New gateway token",
    tokenPlaceholder: "Leave blank to keep the current token",
    clearToken: "Clear gateway token",
    clearTokenDescription: "Disable gateway authentication after saving.",
    configured: "Configured",
    notConfigured: "Not configured",
    effective: (value: string | number) => `Effective: ${value}`,
    overridden: (source: string) => `Controlled by ${source}`,
    restartRequired: "Restart required",
    readOnly: "Create a valid config file before changing settings.",
    readOnlyTitle: "Settings are read-only",
    saved: "Settings saved",
    savedDescription:
      "Runtime values were reconciled with the saved configuration.",
    failed: "Request failed",
    save: "Save settings",
    refresh: "Refresh settings",
  },
  "zh-CN": {
    title: "Gateway 设置",
    description: "运行时与持久化配置",
    network: "网络监听",
    runtime: "运行策略",
    access: "访问控制",
    host: "监听地址",
    port: "监听端口",
    cooldownMs: "429 冷却时间（毫秒）",
    blacklistThreshold: "黑名单阈值",
    balanceRefreshMs: "余额刷新间隔（毫秒）",
    maxRetries: "最大重试次数",
    timeoutMs: "上游超时（毫秒）",
    maxBodyBytes: "请求体上限（字节）",
    token: "新的 Gateway 令牌",
    tokenPlaceholder: "留空则保留当前令牌",
    clearToken: "清除 Gateway 令牌",
    clearTokenDescription: "保存后关闭 Gateway 认证。",
    configured: "已配置",
    notConfigured: "未配置",
    effective: (value: string | number) => `当前生效：${value}`,
    overridden: (source: string) => `当前由 ${source} 接管`,
    restartRequired: "需要重启",
    readOnly: "请先创建有效配置文件，再修改 Gateway 设置。",
    readOnlyTitle: "设置为只读",
    saved: "设置已保存",
    savedDescription: "运行时配置已与持久化配置同步。",
    failed: "请求失败",
    save: "保存设置",
    refresh: "刷新设置",
  },
} as const

const emptyDraft = (): Draft => ({
  host: "",
  port: "",
  cooldownMs: "",
  blacklistThreshold: "",
  balanceRefreshMs: "",
  maxRetries: "",
  timeoutMs: "",
  maxBodyBytes: "",
  token: "",
  clearToken: false,
})

function draftFromSettings(settings: GatewaySettings): Draft {
  return {
    host: settings.persisted.host,
    port: String(settings.persisted.port),
    cooldownMs: String(settings.persisted.cooldownMs),
    blacklistThreshold: String(settings.persisted.blacklistThreshold),
    balanceRefreshMs: String(settings.persisted.balanceRefreshMs),
    maxRetries: String(settings.persisted.maxRetries),
    timeoutMs: String(settings.persisted.timeoutMs),
    maxBodyBytes: String(settings.persisted.maxBodyBytes),
    token: "",
    clearToken: false,
  }
}

export function GatewaySettingsPanel({ locale }: { locale: Locale }) {
  const t = copy[locale]
  const [settings, setSettings] = useState<GatewaySettings | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await apiRequest<GatewaySettings>("/api/settings")
      setSettings(next)
      setDraft(draftFromSettings(next))
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setLoading(false)
    }
  }, [t.failed])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  function update(field: keyof Draft, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value }))
    setNotice(false)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings?.writable) return
    setSaving(true)
    setError("")
    setNotice(false)
    try {
      const payload: Record<string, string | number | boolean> = {
        host: draft.host,
      }
      for (const field of numberFields) payload[field] = Number(draft[field])
      if (draft.token) payload.token = draft.token
      if (draft.clearToken) payload.clearToken = true
      const next = await apiRequest<GatewaySettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
      })
      setSettings(next)
      setDraft(draftFromSettings(next))
      setNotice(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed)
    } finally {
      setSaving(false)
    }
  }

  function settingField(
    field: GatewaySettingField,
    options: { min?: number; max?: number; integer?: boolean } = {}
  ) {
    if (!settings) return null
    const source = settings.overrides[field]
    const restartRequired = settings.restartRequired.includes(
      field as "host" | "port"
    )
    const disabled = !settings.writable || Boolean(source)
    const inputType = field === "host" ? "text" : "number"
    return (
      <Field key={field} data-disabled={disabled || undefined}>
        <FieldLabel htmlFor={`setting-${field}`}>
          {t[field]}
          {source && <Badge variant="outline">{source}</Badge>}
          {restartRequired && (
            <Badge variant="secondary">
              <RotateCcwIcon data-icon="inline-start" />
              {t.restartRequired}
            </Badge>
          )}
        </FieldLabel>
        <Input
          id={`setting-${field}`}
          type={inputType}
          value={draft[field]}
          min={options.min}
          max={options.max}
          step={options.integer === false ? "any" : 1}
          required
          disabled={disabled}
          onChange={(event) => update(field, event.target.value)}
        />
        <FieldDescription>
          {source
            ? t.overridden(source)
            : t.effective(settings.effective[field])}
        </FieldDescription>
      </Field>
    )
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t.description}</p>
          <h2 className="text-xl font-semibold">{t.title}</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t.refresh}
          title={t.refresh}
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </header>

      {error && (
        <Alert variant="destructive">
          <Settings2Icon />
          <AlertTitle>{t.failed}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <CheckCircle2Icon />
          <AlertTitle>{t.saved}</AlertTitle>
          <AlertDescription>{t.savedDescription}</AlertDescription>
        </Alert>
      )}
      {settings && !settings.writable && (
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>{t.readOnlyTitle}</AlertTitle>
          <AlertDescription>{t.readOnly}</AlertDescription>
        </Alert>
      )}

      {settings && (
        <form className="flex flex-col gap-8" onSubmit={handleSubmit}>
          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{t.network}</h3>
            <FieldGroup className="sm:grid sm:grid-cols-2">
              {settingField("host")}
              {settingField("port", { min: 0, max: 65535 })}
            </FieldGroup>
          </section>

          <Separator />

          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{t.runtime}</h3>
            <FieldGroup className="sm:grid sm:grid-cols-2 xl:grid-cols-3">
              {settingField("cooldownMs", { min: 0, integer: false })}
              {settingField("blacklistThreshold", { min: 0 })}
              {settingField("balanceRefreshMs", { min: 0, integer: false })}
              {settingField("maxRetries", { min: 0 })}
              {settingField("timeoutMs", { min: 0, integer: false })}
              {settingField("maxBodyBytes", { min: 1 })}
            </FieldGroup>
          </section>

          <Separator />

          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{t.access}</h3>
            <FieldGroup className="lg:grid lg:grid-cols-2">
              <Field
                data-disabled={
                  !settings.writable || settings.overrides.token
                    ? true
                    : undefined
                }
              >
                <FieldLabel htmlFor="setting-token">
                  {t.token}
                  <Badge
                    variant={
                      settings.persisted.tokenConfigured
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {settings.persisted.tokenConfigured
                      ? t.configured
                      : t.notConfigured}
                  </Badge>
                  {settings.overrides.token && (
                    <Badge variant="outline">{settings.overrides.token}</Badge>
                  )}
                </FieldLabel>
                <Input
                  id="setting-token"
                  type="password"
                  value={draft.token}
                  placeholder={t.tokenPlaceholder}
                  autoComplete="new-password"
                  disabled={
                    !settings.writable || Boolean(settings.overrides.token)
                  }
                  onChange={(event) => {
                    update("token", event.target.value)
                    if (event.target.value) update("clearToken", false)
                  }}
                />
                {settings.overrides.token && (
                  <FieldDescription>
                    {t.overridden(settings.overrides.token)}
                  </FieldDescription>
                )}
              </Field>

              <Field
                orientation="horizontal"
                data-disabled={
                  !settings.writable ||
                  !settings.persisted.tokenConfigured ||
                  settings.overrides.token
                    ? true
                    : undefined
                }
              >
                <FieldContent>
                  <FieldTitle>{t.clearToken}</FieldTitle>
                  <FieldDescription>{t.clearTokenDescription}</FieldDescription>
                </FieldContent>
                <Switch
                  checked={draft.clearToken}
                  disabled={
                    !settings.writable ||
                    !settings.persisted.tokenConfigured ||
                    Boolean(settings.overrides.token)
                  }
                  onCheckedChange={(checked) => {
                    update("clearToken", checked)
                    if (checked) update("token", "")
                  }}
                  aria-label={t.clearToken}
                />
              </Field>
            </FieldGroup>
          </section>

          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !settings.writable}>
              {saving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {t.save}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
