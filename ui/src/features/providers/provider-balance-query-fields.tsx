import { CheckIcon, FileCode2Icon, RefreshCwIcon } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

import type { ProviderCopy } from "./provider-copy"
import {
  DEEPSEEK_BALANCE_SCRIPT,
  OPENROUTER_BALANCE_SCRIPT,
  type ProviderDraft,
} from "./provider-editor-state"

type ProviderBalanceQueryFieldsProps = {
  copy: ProviderCopy
  draft: ProviderDraft
  editingId: string | null
  error: string
  notice: string
  testing: boolean
  setDraft: Dispatch<SetStateAction<ProviderDraft>>
  onTest: () => Promise<void>
}

export function ProviderBalanceQueryFields({
  copy: t,
  draft,
  editingId,
  error,
  notice,
  testing,
  setDraft,
  onTest,
}: ProviderBalanceQueryFieldsProps) {
  return (
    <FieldSet>
      <FieldLegend>{t.balanceQuery}</FieldLegend>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            {draft.balanceQuery.enabled
              ? t.balanceEnabled
              : t.balanceDisabled}
          </FieldTitle>
        </FieldContent>
        <Switch
          checked={draft.balanceQuery.enabled}
          aria-label={t.balanceQuery}
          onCheckedChange={(checked) =>
            setDraft((value) => ({
              ...value,
              balanceQuery: {
                ...value.balanceQuery,
                enabled: checked,
              },
            }))
          }
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft((value) => ({
              ...value,
              balanceQuery: {
                ...value.balanceQuery,
                enabled: true,
                code: DEEPSEEK_BALANCE_SCRIPT,
              },
            }))
          }
        >
          <FileCode2Icon data-icon="inline-start" />
          {t.deepSeekTemplate}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft((value) => ({
              ...value,
              balanceQuery: {
                ...value.balanceQuery,
                enabled: true,
                code: OPENROUTER_BALANCE_SCRIPT,
              },
            }))
          }
        >
          <FileCode2Icon data-icon="inline-start" />
          {t.openRouterTemplate}
        </Button>
      </div>
      {draft.balanceQuery.enabled && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="balance-timeout">
                {t.balanceTimeout}
              </FieldLabel>
              <Input
                id="balance-timeout"
                type="number"
                min="2000"
                max="30000"
                step="1000"
                value={draft.balanceQuery.timeoutMs}
                required
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    balanceQuery: {
                      ...value.balanceQuery,
                      timeoutMs: Number(event.target.value),
                    },
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="balance-refresh">
                {t.balanceRefresh}
              </FieldLabel>
              <Input
                id="balance-refresh"
                type="number"
                min="10000"
                max="86400000"
                step="1000"
                value={draft.balanceQuery.refreshMs ?? ""}
                onChange={(event) =>
                  setDraft((value) => {
                    const refreshMs = event.target.value
                      ? Number(event.target.value)
                      : undefined
                    const nextQuery = {
                      ...value.balanceQuery,
                      refreshMs,
                    }
                    if (refreshMs === undefined) {
                      delete nextQuery.refreshMs
                    }
                    return { ...value, balanceQuery: nextQuery }
                  })
                }
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="balance-script">
              {t.balanceCode}
            </FieldLabel>
            <Textarea
              id="balance-script"
              className="min-h-72 resize-y font-mono text-xs"
              value={draft.balanceQuery.code}
              required
              spellCheck={false}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  balanceQuery: {
                    ...value.balanceQuery,
                    code: event.target.value,
                  },
                }))
              }
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t.failed}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert>
              <CheckIcon />
              <AlertTitle>{notice}</AlertTitle>
            </Alert>
          )}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={
              testing ||
              !draft.balanceQuery.code.trim() ||
              (!editingId &&
                !draft.keys.some((item) => item.key.trim()))
            }
            onClick={() => void onTest()}
          >
            {testing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {t.testBalance}
          </Button>
        </>
      )}
    </FieldSet>
  )
}
