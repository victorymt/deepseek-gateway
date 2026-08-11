import { PlusIcon, XIcon } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

import type { ProviderCopy } from "./provider-copy"
import type { ProviderDraft } from "./provider-editor-state"

type ProviderKeyFieldsProps = {
  copy: ProviderCopy
  draft: ProviderDraft
  editingId: string | null
  setDraft: Dispatch<SetStateAction<ProviderDraft>>
}

export function ProviderKeyFields({
  copy: t,
  draft,
  editingId,
  setDraft,
}: ProviderKeyFieldsProps) {
  const enabledKeyCount = draft.keys.filter((item) => item.enabled).length

  return (
    <FieldSet>
      <FieldLegend>{t.keys}</FieldLegend>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-end"
        onClick={() =>
          setDraft((value) => ({
            ...value,
            keys: [
              ...value.keys,
              {
                name: `key-${value.keys.length + 1}`,
                key: "",
                weight: 1,
                enabled: true,
                alwaysTry: false,
              },
            ],
          }))
        }
      >
        <PlusIcon data-icon="inline-start" />
        {t.addKey}
      </Button>
      {draft.keys.map((key, index) => {
        const isLastEnabledKey = key.enabled && enabledKeyCount === 1
        return (
          <div
            key={`key-${index}`}
            className="grid items-start gap-3 sm:grid-cols-[1fr_1.4fr_7rem_7rem_auto]"
          >
            <Field>
              <FieldLabel htmlFor={`key-name-${index}`}>
                {t.keyName}
              </FieldLabel>
              <Input
                id={`key-name-${index}`}
                value={key.name}
                required
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    keys: value.keys.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, name: event.target.value }
                        : item
                    ),
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`key-secret-${index}`}>
                {t.apiKey}
              </FieldLabel>
              <Input
                id={`key-secret-${index}`}
                type="password"
                value={key.key}
                required={!editingId || !key.maskedKey}
                placeholder={key.maskedKey || "sk-..."}
                autoComplete="new-password"
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    keys: value.keys.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, key: event.target.value }
                        : item
                    ),
                  }))
                }
              />
              {key.maskedKey && (
                <FieldDescription>{t.keepKey}</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor={`key-weight-${index}`}>
                {t.weight}
              </FieldLabel>
              <Input
                id={`key-weight-${index}`}
                type="number"
                min="0.1"
                step="0.1"
                value={key.weight}
                required
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    keys: value.keys.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            weight: Number(event.target.value),
                          }
                        : item
                    ),
                  }))
                }
              />
            </Field>
            <div className="flex flex-col gap-3">
              <Field data-disabled={isLastEnabledKey || undefined}>
                <FieldLabel htmlFor={`key-enabled-${index}`}>
                  {t.keyEnabled}
                </FieldLabel>
                <Switch
                  id={`key-enabled-${index}`}
                  checked={key.enabled}
                  disabled={isLastEnabledKey}
                  onCheckedChange={(checked) =>
                    setDraft((value) => ({
                      ...value,
                      keys: value.keys.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, enabled: checked }
                          : item
                      ),
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`key-always-try-${index}`}>
                  {t.alwaysTry}
                </FieldLabel>
                <Switch
                  id={`key-always-try-${index}`}
                  checked={key.alwaysTry}
                  title={t.alwaysTryDescription}
                  onCheckedChange={(checked) =>
                    setDraft((value) => ({
                      ...value,
                      keys: value.keys.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, alwaysTry: checked }
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
              className="self-end"
              aria-label={t.remove}
              title={t.remove}
              disabled={draft.keys.length === 1 || isLastEnabledKey}
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  keys: value.keys.filter(
                    (_, itemIndex) => itemIndex !== index
                  ),
                }))
              }
            >
              <XIcon />
            </Button>
          </div>
        )
      })}
    </FieldSet>
  )
}
