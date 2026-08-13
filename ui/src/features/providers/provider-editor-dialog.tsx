import type { Dispatch, FormEventHandler, SetStateAction } from "react"
import type { ModelCapabilityCatalog } from "@/gateway-types"

import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import { ProviderBalanceQueryFields } from "./provider-balance-query-fields"
import type { ProviderCopy } from "./provider-copy"
import {
  providerOriginsDiffer,
  setProviderApiProfile,
  setProviderUpstreamFormat,
  type FetchedModel,
  type ProviderDraft,
} from "./provider-editor-state"
import { ProviderKeyFields } from "./provider-key-fields"
import { ProviderModelFields } from "./provider-model-fields"

type ProviderEditorDialogProps = {
  open: boolean
  copy: ProviderCopy
  draft: ProviderDraft
  editingId: string | null
  originalBaseUrl: string
  saving: boolean
  error: string
  balanceTestError: string
  balanceTestNotice: string
  testingBalance: boolean
  fetchedModels: FetchedModel[]
  fetchingModels: boolean
  modelFetchError: string
  modelCapabilities: ModelCapabilityCatalog | null
  setDraft: Dispatch<SetStateAction<ProviderDraft>>
  onAddFetchedModel: (model: FetchedModel) => void
  onFetchModels: () => Promise<void>
  onOpenChange: (open: boolean) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onTestBalance: () => Promise<void>
}

export function ProviderEditorDialog({
  open,
  copy: t,
  draft,
  editingId,
  originalBaseUrl,
  saving,
  error,
  balanceTestError,
  balanceTestNotice,
  testingBalance,
  fetchedModels,
  fetchingModels,
  modelFetchError,
  modelCapabilities,
  setDraft,
  onAddFetchedModel,
  onFetchModels,
  onOpenChange,
  onSubmit,
  onTestBalance,
}: ProviderEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editingId ? t.editTitle : t.addTitle}</DialogTitle>
          <DialogDescription>{t.formDescription}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t.failed}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form className="flex flex-col gap-6" onSubmit={onSubmit}>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="provider-id">{t.providerId}</FieldLabel>
                <Input
                  id="provider-id"
                  value={draft.id}
                  disabled={Boolean(editingId)}
                  required
                  pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      id: event.target.value,
                    }))
                  }
                />
                <FieldDescription>{t.providerIdHint}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-name">{t.name}</FieldLabel>
                <Input
                  id="provider-name"
                  value={draft.name}
                  required
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="provider-url">{t.baseUrl}</FieldLabel>
              <Input
                id="provider-url"
                type="url"
                value={draft.baseUrl}
                required
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    baseUrl: event.target.value,
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-profile">
                {t.apiProfile}
              </FieldLabel>
              <Select
                items={[
                  { value: "generic", label: t.genericApiProfile },
                  { value: "deepseek", label: t.deepSeekApiProfile },
                ]}
                value={draft.apiProfile}
                onValueChange={(value) =>
                  setDraft((current) =>
                    setProviderApiProfile(
                      current,
                      value === "deepseek" ? "deepseek" : "generic",
                      modelCapabilities
                    )
                  )
                }
              >
                <SelectTrigger id="provider-api-profile" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="generic">
                      {t.genericApiProfile}
                    </SelectItem>
                    <SelectItem value="deepseek">
                      {t.deepSeekApiProfile}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{t.apiProfileDescription}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-upstream-format">
                {t.upstreamFormat}
              </FieldLabel>
              <Select
                items={[
                  { value: "responses", label: t.responsesFormat },
                  {
                    value: "chat-completions",
                    label: t.chatCompletionsFormat,
                  },
                ]}
                value={draft.upstreamFormat}
                onValueChange={(value) =>
                  setDraft((current) =>
                    setProviderUpstreamFormat(
                      current,
                      value === "chat-completions"
                        ? "chat-completions"
                        : "responses",
                      modelCapabilities
                    )
                  )
                }
              >
                <SelectTrigger id="provider-upstream-format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="responses">
                      {t.responsesFormat}
                    </SelectItem>
                    <SelectItem value="chat-completions">
                      {t.chatCompletionsFormat}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field
              orientation="horizontal"
              data-disabled={
                draft.upstreamFormat === "chat-completions" || undefined
              }
            >
              <FieldContent>
                <FieldTitle>{t.encryptedAgentMessages}</FieldTitle>
                <FieldDescription>
                  {draft.upstreamFormat === "chat-completions"
                    ? t.encryptedAgentMessagesUnavailable
                    : t.encryptedAgentMessagesDescription}
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label={t.encryptedAgentMessages}
                checked={draft.supportsEncryptedAgentMessages}
                disabled={draft.upstreamFormat === "chat-completions"}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    supportsEncryptedAgentMessages: checked,
                  }))
                }
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{t.enabled}</FieldTitle>
              </FieldContent>
              <Switch
                aria-label={t.enabled}
                checked={draft.enabled}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    enabled: checked,
                  }))
                }
              />
            </Field>

            <ProviderBalanceQueryFields
              copy={t}
              draft={draft}
              editingId={editingId}
              error={balanceTestError}
              notice={balanceTestNotice}
              testing={testingBalance}
              setDraft={setDraft}
              onTest={onTestBalance}
            />

            <ProviderModelFields
              copy={t}
              draft={draft}
              fetchedModels={fetchedModels}
              fetching={fetchingModels}
              fetchError={modelFetchError}
              modelCapabilities={modelCapabilities}
              setDraft={setDraft}
              onAddFetchedModel={onAddFetchedModel}
              onFetchModels={onFetchModels}
            />

            <ProviderKeyFields
              copy={t}
              draft={draft}
              editingId={editingId}
              requireExistingSecrets={providerOriginsDiffer(
                originalBaseUrl,
                draft.baseUrl
              )}
              setDraft={setDraft}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {editingId ? t.save : t.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
