import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  CheckCircle2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"

import type { Locale } from "@/components/language-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import type { GatewaySettingField, GatewaySettings } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"
import { notifyConfigChanged } from "@/lib/setup-actions"

type Draft = Record<GatewaySettingField, string> & {
  token: string
  adminToken: string
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
    adminToken: "New admin token",
    tokenPlaceholder: "Leave blank to keep the current token",
    adminTokenDescription:
      "Used only for console login and management APIs. Keep it separate from the inference token.",
    clearToken: "Clear gateway token",
    clearTokenDescription: "Remove the token stored in the config file.",
    clearTokenConfirmTitle: "Disable gateway authentication?",
    clearTokenConfirmDescription:
      "The persisted gateway token will be removed immediately. Requests will no longer require authentication unless a runtime override is active.",
    cancel: "Cancel",
    authFromConfig: "The token stored in the config file is currently active.",
    authDisabled: "Gateway authentication is currently disabled.",
    persistedConfigured: "A token is also stored in the config file.",
    persistedNotConfigured: "No token is stored in the config file.",
    persisted: (value: string | number) => `Saved: ${value}`,
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
    adminToken: "新的管理令牌",
    tokenPlaceholder: "留空则保留当前令牌",
    adminTokenDescription: "仅用于控制台登录和管理 API，必须与推理令牌不同。",
    clearToken: "清除 Gateway 令牌",
    clearTokenDescription: "删除配置文件中保存的 Gateway 令牌。",
    clearTokenConfirmTitle: "关闭 Gateway 认证？",
    clearTokenConfirmDescription:
      "持久化的 Gateway 令牌将被立即删除。除非存在运行时覆盖，否则后续请求将不再需要认证。",
    cancel: "取消",
    authFromConfig: "配置文件中的 Token 当前正在生效。",
    authDisabled: "Gateway 当前未启用认证。",
    persistedConfigured: "配置文件中也保存了 Token。",
    persistedNotConfigured: "配置文件中没有保存 Token。",
    persisted: (value: string | number) => `配置值：${value}`,
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
  adminToken: "",
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
    adminToken: "",
  }
}

export function GatewaySettingsPanel({
  locale,
  onDirtyChange,
}: {
  locale: Locale
  onDirtyChange?: (dirty: boolean) => void
}) {
  const t = copy[locale]
  const [settings, setSettings] = useState<GatewaySettings | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState(false)
  const [dirty, setDirty] = useState(false)
  const activeRequest = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    try {
      const next = await apiRequest<GatewaySettings>("/api/settings", {
        signal: controller.signal,
      })
      if (sequence !== requestSequence.current) return
      setSettings(next)
      setDraft(draftFromSettings(next))
      setDirty(false)
      setError("")
    } catch (cause) {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Request failed")
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      activeRequest.current?.abort()
    }
  }, [refresh])

  function update(field: keyof Draft, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value }))
    setDirty(true)
    setNotice(false)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!settings?.writable) return
    setSaving(true)
    const sequence = ++requestSequence.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setError("")
    setNotice(false)
    try {
      const payload: Record<string, string | number | boolean> = {
        host: draft.host,
      }
      for (const field of numberFields) payload[field] = Number(draft[field])
      if (draft.token) payload.token = draft.token
      if (draft.adminToken) payload.adminToken = draft.adminToken
      const next = await apiRequest<GatewaySettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (sequence !== requestSequence.current) return
      setSettings(next)
      setDraft(draftFromSettings(next))
      setDirty(false)
      setNotice(true)
      notifyConfigChanged()
    } catch (cause) {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : t.failed)
      }
    } finally {
      if (sequence === requestSequence.current) setSaving(false)
    }
  }

  async function clearToken() {
    if (!settings?.writable || settings.overrides.token) return
    setSaving(true)
    const sequence = ++requestSequence.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setError("")
    setNotice(false)
    try {
      const next = await apiRequest<GatewaySettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ clearToken: true }),
        signal: controller.signal,
      })
      if (sequence !== requestSequence.current) return
      setSettings(next)
      setDraft(draftFromSettings(next))
      setDirty(false)
      setNotice(true)
      setClearDialogOpen(false)
      notifyConfigChanged()
    } catch (cause) {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : t.failed)
      }
    } finally {
      if (sequence === requestSequence.current) setSaving(false)
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
        <FieldLabel className="flex-wrap" htmlFor={`setting-${field}`}>
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
          value={source ? String(settings.effective[field]) : draft[field]}
          min={options.min}
          max={options.max}
          step={options.integer === false ? "any" : 1}
          required
          disabled={disabled}
          onChange={(event) => update(field, event.target.value)}
        />
        <FieldDescription>
          {source
            ? `${t.overridden(source)} · ${t.persisted(settings.persisted[field])}`
            : t.effective(settings.effective[field])}
        </FieldDescription>
      </Field>
    )
  }

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t.description}</p>
          <h1 className="text-xl font-semibold">{t.title}</h1>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          aria-label={t.refresh}
          title={t.refresh}
          disabled={loading || saving || dirty}
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
        <form className="flex max-w-3xl flex-col gap-8" onSubmit={handleSubmit}>
          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{t.network}</h3>
            <FieldGroup className="settings-field-grid">
              {settingField("host")}
              {settingField("port", { min: 0, max: 65535 })}
            </FieldGroup>
          </section>

          <Separator />

          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">{t.runtime}</h3>
            <FieldGroup className="settings-field-grid settings-field-grid-compact">
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
            <FieldGroup className="settings-field-grid">
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
                      settings.effective.tokenConfigured
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {settings.effective.tokenConfigured
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
                  }}
                />
                <FieldDescription>
                  {settings.overrides.token
                    ? `${t.overridden(settings.overrides.token)} ${
                        settings.persisted.tokenConfigured
                          ? t.persistedConfigured
                          : t.persistedNotConfigured
                      }`
                    : settings.effective.tokenConfigured
                      ? t.authFromConfig
                      : t.authDisabled}
                </FieldDescription>
              </Field>

              <Field data-disabled={!settings.writable ? true : undefined}>
                <FieldLabel htmlFor="setting-admin-token">
                  {t.adminToken}
                  <Badge
                    variant={
                      settings.effective.adminTokenConfigured
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {settings.effective.adminTokenConfigured
                      ? t.configured
                      : t.notConfigured}
                  </Badge>
                </FieldLabel>
                <Input
                  id="setting-admin-token"
                  type="password"
                  value={draft.adminToken}
                  placeholder={t.tokenPlaceholder}
                  autoComplete="new-password"
                  disabled={!settings.writable}
                  onChange={(event) => {
                    update("adminToken", event.target.value)
                  }}
                />
                <FieldDescription>{t.adminTokenDescription}</FieldDescription>
              </Field>

              <Field
                className="flex-wrap sm:flex-nowrap"
                orientation="horizontal"
                data-disabled={
                  !settings.writable ||
                  !settings.persisted.tokenConfigured ||
                  settings.overrides.token ||
                  dirty
                    ? true
                    : undefined
                }
              >
                <FieldContent>
                  <FieldTitle>{t.clearToken}</FieldTitle>
                  <FieldDescription>{t.clearTokenDescription}</FieldDescription>
                </FieldContent>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    !settings.writable ||
                    !settings.persisted.tokenConfigured ||
                    Boolean(settings.overrides.token) ||
                    dirty ||
                    saving
                  }
                  onClick={() => setClearDialogOpen(true)}
                  aria-label={t.clearToken}
                >
                  <Trash2Icon data-icon="inline-start" />
                  {t.clearToken}
                </Button>
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

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.clearTokenConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.clearTokenConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saving}
              onClick={() => void clearToken()}
            >
              {saving ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Trash2Icon data-icon="inline-start" />
              )}
              {t.clearToken}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
