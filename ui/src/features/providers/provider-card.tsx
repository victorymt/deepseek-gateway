import {
  FileCode2Icon,
  PencilIcon,
  PlugZapIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldTitle,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { Provider } from "@/gateway-types"

import type { ProviderCopy } from "./provider-copy"

type ProviderCardProps = {
  provider: Provider
  defaultProvider: string
  defaultModel: string
  testing: boolean
  copy: ProviderCopy
  onDelete: (providerId: string) => Promise<void>
  onEdit: (provider: Provider) => void
  onPatch: (
    providerId: string,
    payload: Record<string, unknown>
  ) => Promise<void>
  onTest: (providerId: string) => Promise<void>
}

export function ProviderCard({
  provider,
  defaultProvider,
  defaultModel,
  testing,
  copy: t,
  onDelete,
  onEdit,
  onPatch,
  onTest,
}: ProviderCardProps) {
  const isDefault = defaultProvider === provider.id

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {provider.name}
          <Badge variant={provider.enabled ? "secondary" : "outline"}>
            {provider.enabled ? t.enabled : t.disabled}
          </Badge>
          <Badge variant="outline">
            {provider.upstreamFormat === "chat-completions"
              ? t.chatCompletionsFormat
              : t.responsesFormat}
          </Badge>
          {isDefault && <Badge>{t.default}</Badge>}
          <Badge
            variant={
              provider.balanceQuery?.enabled ? "secondary" : "outline"
            }
          >
            <FileCode2Icon data-icon="inline-start" />
            {provider.balanceQuery?.enabled
              ? t.balanceEnabled
              : t.balanceDisabled}
          </Badge>
        </CardTitle>
        <CardDescription className="font-mono break-all">
          {provider.baseUrl}
        </CardDescription>
        <CardAction className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.test}
            title={t.test}
            disabled={testing}
            onClick={() => void onTest(provider.id)}
          >
            {testing ? <Spinner /> : <PlugZapIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.edit}
            title={t.edit}
            onClick={() => onEdit(provider)}
          >
            <PencilIcon />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.remove}
                  title={t.remove}
                />
              }
            >
              <Trash2Icon />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t.deleteDescription}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void onDelete(provider.id)}
                >
                  <Trash2Icon data-icon="inline-start" />
                  {t.delete}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field
          orientation="horizontal"
          data-disabled={isDefault || undefined}
        >
          <FieldContent>
            <FieldTitle>{t.enabled}</FieldTitle>
            <FieldDescription>{provider.id}</FieldDescription>
          </FieldContent>
          <Switch
            aria-label={t.enabled}
            checked={provider.enabled}
            disabled={isDefault}
            onCheckedChange={(checked) =>
              void onPatch(provider.id, { enabled: checked })
            }
          />
        </Field>
        {!isDefault && provider.enabled && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              void onPatch(provider.id, { makeDefault: true })
            }
          >
            <StarIcon data-icon="inline-start" />
            {t.setDefault}
          </Button>
        )}
        <Separator />
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{t.models}</p>
          {provider.models.map((model) => (
            <div
              key={model.alias}
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{model.name}</p>
                  {model.inputModalities.includes("image") && (
                    <Badge variant="secondary">{t.imageInput}</Badge>
                  )}
                  {!model.inputModalities.includes("image") && (
                    <Badge variant="outline">{t.textOnly}</Badge>
                  )}
                  {model.supportsHostedWebSearch && (
                    <Badge variant="secondary">
                      <SearchIcon data-icon="inline-start" />
                      {t.hostedWebSearch}
                    </Badge>
                  )}
                </div>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {model.alias} → {model.upstreamModel}
                </p>
              </div>
              {defaultModel === model.alias ? (
                <Badge variant="outline">{t.default}</Badge>
              ) : provider.enabled ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.setDefaultModel}
                  title={t.setDefaultModel}
                  onClick={() =>
                    void onPatch(provider.id, {
                      makeDefault: true,
                      defaultModel: model.alias,
                    })
                  }
                >
                  <StarIcon />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <Separator />
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{t.keys}</p>
          {provider.keys.map((key) => (
            <div
              key={key.fingerprint}
              className="flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-sm">{key.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {key.maskedKey} · {t.fingerprint} {key.fingerprint}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline">
                  {t.weight} {key.weight}
                </Badge>
                <Badge variant={key.enabled ? "secondary" : "outline"}>
                  {key.enabled ? t.enabled : t.disabled}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
