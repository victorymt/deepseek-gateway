import { CheckIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import type {
  ModelCapabilityCatalog,
  ReasoningParameter,
} from "@/gateway-types"

import type { ProviderCopy } from "./provider-copy"
import {
  modelDraftForUpstreamModel,
  modelDraftWithReasoningEnabled,
  type FetchedModel,
  type ProviderDraft,
} from "./provider-editor-state"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const REASONING_PARAMETERS: Array<{
  value: ReasoningParameter
  label: string
}> = [
  { value: "reasoning_effort", label: "reasoning_effort" },
  { value: "enable_thinking", label: "enable_thinking" },
  { value: "thinking_budget", label: "thinking_budget" },
]

function updateReasoningLevels(
  model: ProviderDraft["models"][number],
  text: string,
  parameter = model.reasoning?.parameter ?? "reasoning_effort",
  valuesText?: string
) {
  const efforts = [
    ...new Set(
      text
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]
  if (!efforts.length) return undefined
  const existing = new Map(
    model.reasoning?.levels.map((level) => [level.effort, level]) ?? []
  )
  const mappedValues =
    valuesText === undefined
      ? null
      : valuesText.split(",").map((value) => value.trim())
  const levels = efforts.map((effort, index) => {
    const level = { ...(existing.get(effort) ?? {}), effort }
    if (mappedValues) {
      const raw = mappedValues[index] ?? ""
      if (!raw) delete level.upstreamValue
      else if (raw === "true" || raw === "false") {
        level.upstreamValue = raw === "true"
      } else if (Number.isFinite(Number(raw))) {
        level.upstreamValue = Number(raw)
      } else {
        level.upstreamValue = raw
      }
    }
    return level
  })
  const defaultEffort = levels.some(
    (level) => level.effort === model.reasoning?.default
  )
    ? model.reasoning!.default
    : levels[0].effort
  return {
    parameter,
    default: defaultEffort,
    levels,
  }
}

function reasoningValuesText(model: ProviderDraft["models"][number]) {
  const values = model.reasoning?.levels.map((level) => level.upstreamValue)
  return values?.some((value) => value !== undefined)
    ? values.map((value) => value ?? "").join(", ")
    : ""
}

type ProviderModelFieldsProps = {
  copy: ProviderCopy
  draft: ProviderDraft
  fetchedModels: FetchedModel[]
  fetching: boolean
  fetchError: string
  modelCapabilities: ModelCapabilityCatalog | null
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
  modelCapabilities,
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
                  supportsCustomApplyPatch: false,
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
                    <Badge className="mt-1" variant="outline">
                      {model.inputModalities.includes("image")
                        ? t.imageInput
                        : t.textOnly}
                    </Badge>
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
          className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(160px,280px)_auto]"
        >
          <Field className="min-w-0">
            <FieldLabel htmlFor={`model-id-${index}`}>{t.modelId}</FieldLabel>
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
          <Field className="min-w-0">
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
          <Field className="min-w-0">
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
                      ? modelDraftForUpstreamModel(
                          item,
                          event.target.value,
                          modelCapabilities,
                          value
                        )
                      : item
                  ),
                }))
              }
            />
          </Field>
          <div className="flex min-w-0 flex-col gap-3">
            <Field orientation="horizontal">
              <FieldContent className="min-w-0">
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
              <FieldContent className="min-w-0">
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
            <Field
              orientation="horizontal"
              data-disabled={
                draft.upstreamFormat === "chat-completions" || undefined
              }
            >
              <FieldContent className="min-w-0">
                <FieldTitle>{t.customApplyPatch}</FieldTitle>
                <FieldDescription>
                  {draft.upstreamFormat === "chat-completions"
                    ? t.customApplyPatchUnavailable
                    : t.customApplyPatchDescription}
                </FieldDescription>
              </FieldContent>
              <Switch
                size="sm"
                aria-label={t.customApplyPatch}
                checked={model.supportsCustomApplyPatch}
                disabled={draft.upstreamFormat === "chat-completions"}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    models: value.models.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            supportsCustomApplyPatch: checked,
                          }
                        : item
                    ),
                  }))
                }
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent className="min-w-0">
                <FieldTitle>{t.reasoning}</FieldTitle>
                <FieldDescription>{t.reasoningDescription}</FieldDescription>
              </FieldContent>
              <Switch
                size="sm"
                aria-label={t.reasoning}
                checked={Boolean(model.reasoning)}
                onCheckedChange={(checked) =>
                  setDraft((value) => ({
                    ...value,
                    models: value.models.map((item, itemIndex) =>
                      itemIndex === index
                        ? modelDraftWithReasoningEnabled(
                            item,
                            checked,
                            modelCapabilities
                          )
                        : item
                    ),
                  }))
                }
              />
            </Field>
          </div>
          {model.reasoning && (
            <div className="grid min-w-0 gap-3 rounded-md border p-3 sm:col-span-4 sm:grid-cols-4">
              <Field>
                <FieldLabel htmlFor={`reasoning-levels-${index}`}>
                  {t.reasoningLevels}
                </FieldLabel>
                <Input
                  id={`reasoning-levels-${index}`}
                  value={model.reasoning.levels
                    .map((level) => level.effort)
                    .join(", ")}
                  placeholder="low, medium, high"
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      models: value.models.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              reasoning: updateReasoningLevels(
                                item,
                                event.target.value,
                                item.reasoning?.parameter
                              ),
                            }
                          : item
                      ),
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`reasoning-parameter-${index}`}>
                  {t.reasoningParameter}
                </FieldLabel>
                <Select
                  value={model.reasoning.parameter}
                  onValueChange={(value) => {
                    if (!value) return
                    setDraft((current) => ({
                      ...current,
                      models: current.models.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              reasoning: updateReasoningLevels(
                                item,
                                item.reasoning?.levels
                                  .map((level) => level.effort)
                                  .join(", ") ?? "",
                                value as ReasoningParameter,
                                item.reasoning?.levels
                                  .map((level) => level.upstreamValue ?? "")
                                  .join(", ")
                              ),
                            }
                          : item
                      ),
                    }))
                  }}
                >
                  <SelectTrigger
                    id={`reasoning-parameter-${index}`}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {REASONING_PARAMETERS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`reasoning-values-${index}`}>
                  {t.reasoningValues}
                </FieldLabel>
                <Input
                  id={`reasoning-values-${index}`}
                  value={reasoningValuesText(model)}
                  placeholder="Optional; one value per level"
                  onChange={(event) =>
                    setDraft((value) => ({
                      ...value,
                      models: value.models.map((item, itemIndex) =>
                        itemIndex === index && item.reasoning
                          ? {
                              ...item,
                              reasoning: updateReasoningLevels(
                                item,
                                item.reasoning.levels
                                  .map((level) => level.effort)
                                  .join(", "),
                                item.reasoning.parameter,
                                event.target.value
                              ),
                            }
                          : item
                      ),
                    }))
                  }
                />
                <FieldDescription>
                  {t.reasoningValuesDescription}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`reasoning-default-${index}`}>
                  {t.reasoningDefault}
                </FieldLabel>
                <Select
                  value={model.reasoning.default}
                  onValueChange={(value) => {
                    if (!value) return
                    setDraft((current) => ({
                      ...current,
                      models: current.models.map((item, itemIndex) =>
                        itemIndex === index && item.reasoning
                          ? {
                              ...item,
                              reasoning: {
                                ...item.reasoning,
                                default: value,
                              },
                            }
                          : item
                      ),
                    }))
                  }}
                >
                  <SelectTrigger
                    id={`reasoning-default-${index}`}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {model.reasoning.levels.map((level) => (
                        <SelectItem key={level.effort} value={level.effort}>
                          {level.effort}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
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
