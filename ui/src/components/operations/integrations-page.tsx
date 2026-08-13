import { useCallback, useState, type FormEvent } from "react"
import { PencilIcon, PlusIcon, Trash2Icon, WifiIcon } from "lucide-react"

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
import type { Integration } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { ConfirmAction, OperationsPageShell } from "./page-shell"
import { useOperationsPage } from "./page-state"
import type { IntegrationDraft, OperationsPageProps } from "./types"

export default function IntegrationsPage({
  locale,
  active,
}: OperationsPageProps) {
  const zh = locale === "zh-CN"
  const [draft, setDraft] = useState<IntegrationDraft | null>(null)
  const load = useCallback(async (signal: AbortSignal) => {
    const result = await apiRequest<{ integrations: Integration[] }>(
      "/api/integrations",
      { signal }
    )
    return result.integrations
  }, [])
  const page = useOperationsPage(load, active, [])
  const integrations = page.data

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    const submitted = draft
    const saved = await page.action(
      draft.id ? `/api/integrations/${draft.id}` : "/api/integrations",
      {
        method: draft.id ? "PATCH" : "POST",
        body: JSON.stringify(draft),
      },
      zh ? "集成已保存" : "Integration saved"
    )
    if (!page.isMounted()) return
    setDraft((current) => draftAfterSubmit(current, submitted, saved))
  }

  return (
    <OperationsPageShell
      kind="integrations"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
    >
      <div className="operation-stack">
        <Button
          onClick={() =>
            setDraft({ name: "", type: "openai", baseUrl: "", enabled: true })
          }
        >
          <PlusIcon data-icon="inline-start" />
          {zh ? "添加集成" : "Add integration"}
        </Button>
        {draft && (
          <Card>
            <CardHeader>
              <CardTitle>
                {draft.id
                  ? zh
                    ? "编辑集成"
                    : "Edit integration"
                  : zh
                    ? "添加集成"
                    : "Add integration"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form className="draft-form" onSubmit={submit}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="integration-name">Name</FieldLabel>
                    <Input
                      id="integration-name"
                      required
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Type</FieldLabel>
                    <Select
                      value={draft.type}
                      onValueChange={(value) =>
                        setDraft({ ...draft, type: String(value) })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="openai">OpenAI</SelectItem>
                          <SelectItem value="anthropic">Anthropic</SelectItem>
                          <SelectItem value="webhook">Webhook</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="integration-url">Base URL</FieldLabel>
                    <Input
                      id="integration-url"
                      required
                      type="url"
                      placeholder="https://example.com/v1"
                      value={draft.baseUrl}
                      onChange={(event) =>
                        setDraft({ ...draft, baseUrl: event.target.value })
                      }
                    />
                  </Field>
                  <Field orientation="horizontal">
                    <FieldLabel htmlFor="integration-enabled">
                      Enabled
                    </FieldLabel>
                    <Switch
                      id="integration-enabled"
                      checked={draft.enabled}
                      onCheckedChange={(enabled) =>
                        setDraft({ ...draft, enabled })
                      }
                    />
                  </Field>
                </FieldGroup>
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDraft(null)}
                  >
                    {zh ? "取消" : "Cancel"}
                  </Button>
                  <Button type="submit" disabled={Boolean(page.pendingAction)}>
                    {page.pendingAction
                      ? zh
                        ? "保存中..."
                        : "Saving..."
                      : zh
                        ? "保存"
                        : "Save"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
        {integrations.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <div className="operation-row">
                <CardTitle>{item.name}</CardTitle>
                <Badge>{item.enabled ? "Enabled" : "Disabled"}</Badge>
              </div>
              <CardDescription>
                {item.type} · {item.baseUrl}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="operation-row">
                <span>
                  <Switch
                    checked={item.enabled}
                    aria-label={
                      zh ? `${item.name} 启用状态` : `${item.name} enabled`
                    }
                    disabled={Boolean(page.pendingAction)}
                    onCheckedChange={(enabled) =>
                      void page.action(
                        `/api/integrations/${item.id}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ ...item, enabled }),
                        },
                        zh ? "状态已更新" : "Status updated"
                      )
                    }
                  />
                </span>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(page.pendingAction)}
                    onClick={() =>
                      void page.action(
                        `/api/integrations/${item.id}/test`,
                        { method: "POST" },
                        zh ? "集成已测试" : "Integration tested"
                      )
                    }
                  >
                    <WifiIcon data-icon="inline-start" />
                    {zh ? "测试" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={zh ? "编辑集成" : "Edit integration"}
                    title={zh ? "编辑集成" : "Edit integration"}
                    onClick={() => setDraft(item)}
                  >
                    <PencilIcon />
                  </Button>
                  <ConfirmAction
                    zh={zh}
                    title={zh ? "删除集成？" : "Delete integration?"}
                    description={item.name}
                    destructive
                    action={() =>
                      void page.action(
                        `/api/integrations/${item.id}`,
                        { method: "DELETE" },
                        zh ? "集成已删除" : "Integration deleted"
                      )
                    }
                  >
                    <Trash2Icon />
                  </ConfirmAction>
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
        {!page.loading && !integrations.length && !draft && (
          <p className="empty-copy">
            {zh ? "暂无集成" : "No integrations configured"}
          </p>
        )}
      </div>
    </OperationsPageShell>
  )
}
