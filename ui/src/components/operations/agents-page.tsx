import { useCallback, useState, type FormEvent } from "react"
import { PencilIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react"

import { draftAfterSubmit } from "@/components/operations-draft-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { ProviderConfig, Subagent } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { ConfirmAction, OperationsPageShell } from "./page-shell"
import { useOperationsAutoRefresh, useOperationsPage } from "./page-state"
import type { OperationsPageProps, SubagentDraft } from "./types"

type AgentsData = {
  providerConfig: ProviderConfig | null
  agents: Subagent[]
}

const initialAgentsData: AgentsData = { providerConfig: null, agents: [] }

export default function AgentsPage({ locale, active }: OperationsPageProps) {
  const zh = locale === "zh-CN"
  const [draft, setDraft] = useState<SubagentDraft | null>(null)
  const load = useCallback(async (signal: AbortSignal) => {
    const [providers, result] = await Promise.all([
      apiRequest<ProviderConfig>("/api/providers", { signal }),
      apiRequest<{ subagents: Subagent[] }>("/api/subagents", { signal }),
    ])
    return { providerConfig: providers, agents: result.subagents }
  }, [])
  const page = useOperationsPage(load, active, initialAgentsData)
  const { providerConfig, agents } = page.data
  useOperationsAutoRefresh(page.refresh, 0, Boolean(draft), active)

  const selectedProvider = providerConfig?.providers.find(
    (provider) => provider.id === draft?.providerId
  )
  const enabledProviders =
    providerConfig?.providers.filter((provider) => provider.enabled) || []
  const selectableProviders =
    providerConfig?.providers.filter(
      (provider) => provider.enabled || provider.id === draft?.providerId
    ) || []
  const defaultProvider =
    enabledProviders.find((provider) => provider.models.length > 0) ||
    enabledProviders[0]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    const submitted = draft
    const saved = await page.action(
      draft.id ? `/api/subagents/${draft.id}` : "/api/subagents",
      {
        method: draft.id ? "PATCH" : "POST",
        body: JSON.stringify(draft),
      },
      zh ? "子代理已保存" : "Subagent saved"
    )
    if (!page.isMounted()) return
    setDraft((current) => draftAfterSubmit(current, submitted, saved))
  }

  return (
    <OperationsPageShell
      kind="agents"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
    >
      <div className="operation-stack">
        <Card>
          <CardHeader>
            <CardTitle>
              <UsersIcon />
              {zh ? "Codex 原生子代理" : "Native Codex subagents"}
            </CardTitle>
            <CardDescription>
              {zh
                ? "管理投影到 Codex agents 目录的独立代理配置。"
                : "Manage independent agent configurations projected into the Codex agents directory."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="agent-list">
              {agents.map((agent) => (
                <div className="operation-row" key={agent.id}>
                  <span className="agent-summary">
                    <strong>{agent.name}</strong>
                    <span>{agent.description}</span>
                    <small>
                      {agent.providerId} · {agent.model}
                    </small>
                    <code
                      title={
                        agent.projection.path ||
                        `${agent.projection.codexHome.replace(/[\\/]+$/, "")}/agents/${agent.name}.toml`
                      }
                    >
                      agents/{agent.name}.toml
                    </code>
                  </span>
                  <span className="agent-actions">
                    <Switch
                      id={`agent-enabled-${agent.id}`}
                      checked={agent.enabled}
                      aria-label={
                        zh ? `${agent.name} 启用状态` : `${agent.name} enabled`
                      }
                      title={
                        agent.enabled
                          ? zh
                            ? "停用子代理"
                            : "Disable subagent"
                          : zh
                            ? "启用子代理"
                            : "Enable subagent"
                      }
                      disabled={Boolean(page.pendingAction)}
                      onCheckedChange={(enabled) =>
                        void page.action(
                          `/api/subagents/${agent.id}`,
                          {
                            method: "PATCH",
                            body: JSON.stringify({ ...agent, enabled }),
                          },
                          zh ? "状态已更新" : "Status updated"
                        )
                      }
                    />
                    <Badge
                      variant={
                        agent.projection.installed ? "default" : "outline"
                      }
                    >
                      {agent.projection.status}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        zh ? `编辑子代理 ${agent.name}` : `Edit ${agent.name}`
                      }
                      title={
                        zh ? `编辑子代理 ${agent.name}` : `Edit ${agent.name}`
                      }
                      onClick={() => setDraft(agent)}
                    >
                      <PencilIcon />
                    </Button>
                    <ConfirmAction
                      zh={zh}
                      title={
                        zh
                          ? `删除子代理 ${agent.name}？`
                          : `Delete ${agent.name}?`
                      }
                      description={agent.name}
                      destructive
                      iconOnly
                      action={() =>
                        void page.action(
                          `/api/subagents/${agent.id}`,
                          { method: "DELETE" },
                          zh ? "子代理已删除" : "Subagent deleted"
                        )
                      }
                    >
                      <Trash2Icon />
                    </ConfirmAction>
                  </span>
                </div>
              ))}
            </div>
            {!agents.length && (
              <p className="empty-copy">
                {zh ? "暂无子代理配置" : "No subagents configured"}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              {draft?.id
                ? zh
                  ? "编辑子代理"
                  : "Edit subagent"
                : zh
                  ? "添加子代理"
                  : "Add subagent"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form className="draft-form" onSubmit={submit}>
              <FieldGroup>
                {!draft && (
                  <Button
                    type="button"
                    disabled={!defaultProvider?.models.length}
                    title={
                      defaultProvider?.models.length
                        ? undefined
                        : zh
                          ? "请先启用至少一个包含模型的 Provider"
                          : "Enable a provider with at least one model first"
                    }
                    onClick={() =>
                      setDraft({
                        name: "",
                        description: "",
                        providerId: defaultProvider?.id || "",
                        model: defaultProvider?.models[0]?.alias || "",
                        developerInstructions: "",
                        enabled: true,
                      })
                    }
                  >
                    <PlusIcon data-icon="inline-start" />
                    {zh ? "开始配置" : "Start configuration"}
                  </Button>
                )}
                {draft && (
                  <>
                    <Field>
                      <FieldLabel htmlFor="subagent-name">
                        {zh ? "名称" : "Name"}
                      </FieldLabel>
                      <Input
                        id="subagent-name"
                        required
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="subagent-description">
                        {zh ? "描述" : "Description"}
                      </FieldLabel>
                      <Input
                        id="subagent-description"
                        required
                        value={draft.description}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            description: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="subagent-provider">
                        Provider
                      </FieldLabel>
                      <Select
                        value={draft.providerId}
                        onValueChange={(value) => {
                          const provider = providerConfig?.providers.find(
                            (item) => item.id === String(value)
                          )
                          setDraft({
                            ...draft,
                            providerId: String(value),
                            model: provider?.models[0]?.alias || "",
                          })
                        }}
                      >
                        <SelectTrigger id="subagent-provider">
                          <SelectValue placeholder="Provider" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {selectableProviders.map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {provider.name}
                                {!provider.enabled &&
                                  (zh ? "（已停用）" : " (Disabled)")}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="subagent-model">
                        {zh ? "模型" : "Model"}
                      </FieldLabel>
                      <Select
                        value={draft.model}
                        onValueChange={(value) =>
                          setDraft({ ...draft, model: String(value) })
                        }
                      >
                        <SelectTrigger
                          id="subagent-model"
                          disabled={!selectedProvider?.models.length}
                        >
                          <SelectValue placeholder="Model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {selectedProvider?.models.map((model) => (
                              <SelectItem key={model.alias} value={model.alias}>
                                {model.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="subagent-instructions">
                        {zh ? "开发者指令" : "Developer instructions"}
                      </FieldLabel>
                      <Textarea
                        id="subagent-instructions"
                        required
                        value={draft.developerInstructions}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            developerInstructions: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel htmlFor="subagent-enabled">
                        {zh ? "启用" : "Enabled"}
                      </FieldLabel>
                      <Switch
                        id="subagent-enabled"
                        checked={draft.enabled}
                        onCheckedChange={(enabled) =>
                          setDraft({ ...draft, enabled })
                        }
                      />
                    </Field>
                    <div className="form-actions">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDraft(null)}
                      >
                        {zh ? "取消" : "Cancel"}
                      </Button>
                      <Button
                        type="submit"
                        disabled={Boolean(page.pendingAction)}
                      >
                        {page.pendingAction
                          ? zh
                            ? "保存中..."
                            : "Saving..."
                          : zh
                            ? "保存"
                            : "Save"}
                      </Button>
                    </div>
                  </>
                )}
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </OperationsPageShell>
  )
}
