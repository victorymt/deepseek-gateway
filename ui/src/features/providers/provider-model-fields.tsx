import { CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import type { ProviderCopy } from "./provider-copy"
import type {
  FetchedModel,
  ProviderDraft,
} from "./provider-editor-state"

type ProviderModelFieldsProps = {
  copy: ProviderCopy
  draft: ProviderDraft
  fetchedModels: FetchedModel[]
  fetching: boolean
  fetchError: string
  setDraft: Dispatch<SetStateAction<ProviderDraft>>
  onAddFetchedModel: (model: FetchedModel) => void
  onFetchModels: () => Promise<void>
}

export function ProviderModelFields({
  copy: t,
  draft,
  fetchedModels,
  fetching,
  fetchError,
  setDraft,
  onAddFetchedModel,
  onFetchModels,
}: ProviderModelFieldsProps) {
  return (
    <FieldSet>
      <FieldLegend>{t.models}</FieldLegend>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fetching || !draft.baseUrl.trim()}
          onClick={() => void onFetchModels()}
        >
          {fetching ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          {t.fetchModels}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft((value) => ({
              ...value,
              models: [
                ...value.models,
                {
                  id: "",
                  name: "",
                  upstreamModel: "",
                  inputModalities: ["text"],
                  supportsHostedWebSearch: false,
                },
              ],
            }))
          }
        >
          <PlusIcon data-icon="inline-start" />
          {t.addModel}
        </Button>
      </div>
      {fetchError && (
        <p className="text-sm text-destructive" role="alert">
          {fetchError}
        </p>
      )}
      {fetchedModels.length > 0 && (
        <div className="overflow-hidden rounded-md border bg-muted/20">
          <div className="border-b px-3 py-2 text-sm font-medium">
            {t.modelsFound(fetchedModels.length)}
          </div>
          <div className="max-h-52 divide-y overflow-y-auto">
            {fetchedModels.map((model) => {
              const added = draft.models.some(
                (item) => item.upstreamModel === model.upstreamModel
              )
              return (
                <div
                  key={model.upstreamModel}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">
                      {model.upstreamModel}
                    </p>
                    {model.ownedBy && (
                      <p className="text-xs text-muted-foreground">
                        {model.ownedBy}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={added}
                    onClick={() => onAddFetchedModel(model)}
                  >
                    {added ? (
                      <CheckIcon data-icon="inline-start" />
                    ) : (
                      <PlusIcon data-icon="inline-start" />
                    )}
                    {added ? t.modelAdded : t.addFetchedModel}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {draft.models.map((model, index) => (
        <div
          key={`model-${index}`}
          className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto_auto]"
        >
          <Field>
            <FieldLabel htmlFor={`model-id-${index}`}>
              {t.modelId}
            </FieldLabel>
            <Input
              id={`model-id-${index}`}
              value={model.id}
              required
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  models: value.models.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, id: event.target.value }
                      : item
                  ),
                }))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`model-name-${index}`}>
              {t.modelName}
            </FieldLabel>
            <Input
              id={`model-name-${index}`}
              value={model.name}
              required
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  models: value.models.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, name: event.target.value }
                      : item
                  ),
                }))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`upstream-model-${index}`}>
              {t.upstreamModel}
            </FieldLabel>
            <Input
              id={`upstream-model-${index}`}
              value={model.upstreamModel}
              required
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  models: value.models.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, upstreamModel: event.target.value }
                      : item
                  ),
                }))
              }
            />
          </Field>
          <div className="flex flex-col gap-3">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{t.imageInput}</FieldTitle>
              </FieldContent>
              <Switch
                size="sm"
                aria-label={t.imageInput}
                checked={model.inputModalities.includes("image")}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    models: value.models.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            inputModalities: checked
                              ? ["text", "image"]
                              : ["text"],
                          }
                        : item
                    ),
                  }))
                }
              />
            </Field>
            <Field
              orientation="horizontal"
              data-disabled={
                draft.upstreamFormat === "chat-completions" || undefined
              }
            >
              <FieldContent>
                <FieldTitle>{t.hostedWebSearch}</FieldTitle>
                <FieldDescription>
                  {draft.upstreamFormat === "chat-completions"
                    ? t.hostedWebSearchUnavailable
                    : t.hostedWebSearchDescription}
                </FieldDescription>
              </FieldContent>
              <Switch
                size="sm"
                aria-label={t.hostedWebSearch}
                checked={model.supportsHostedWebSearch}
                disabled={draft.upstreamFormat === "chat-completions"}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    models: value.models.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            supportsHostedWebSearch: checked,
                          }
                        : item
                    ),
                  }))
                }
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t.remove}
            title={t.remove}
            disabled={draft.models.length === 1}
            onClick={() =>
              setDraft((value) => ({
                ...value,
                models: value.models.filter(
                  (_, itemIndex) => itemIndex !== index
                ),
              }))
            }
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </FieldSet>
  )
}
