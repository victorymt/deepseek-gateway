import { useRef, useState, type ChangeEvent, type DragEvent } from "react"
import { FileUpIcon, UploadIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { KeyImportResult } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import type { ProviderKeyCopy } from "./types"

type ImportMode = "text" | "file"
const MAX_IMPORT_FILE_BYTES = 1024 * 1024

export function ImportKeysDialog({
  providerId,
  providerName,
  copy,
  open,
  onOpenChange,
  onSuccess,
}: {
  providerId: string
  providerName: string
  copy: ProviderKeyCopy
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (result: KeyImportResult) => Promise<void>
}) {
  const [mode, setMode] = useState<ImportMode>("text")
  const [keysText, setKeysText] = useState("")
  const [fileName, setFileName] = useState("")
  const [weight, setWeight] = useState("1")
  const [enabled, setEnabled] = useState(true)
  const [alwaysTry, setAlwaysTry] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function loadFile(file: File) {
    if (!/\.(txt|json)$/i.test(file.name)) {
      setFileName("")
      setKeysText("")
      setError(copy.importFileTypeInvalid)
      return
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setFileName("")
      setKeysText("")
      setError(copy.importFileTooLarge)
      return
    }
    try {
      setError("")
      setFileName(file.name)
      setKeysText(await file.text())
      setMode("file")
    } catch (cause) {
      setFileName("")
      setKeysText("")
      setError(cause instanceof Error ? cause.message : copy.importFailed)
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void loadFile(file)
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void loadFile(file)
  }

  async function handleSubmit() {
    if (!keysText.trim() || loading) return
    setLoading(true)
    setError("")
    try {
      const result = await apiRequest<KeyImportResult>(
        `/api/providers/${encodeURIComponent(providerId)}/keys/import`,
        {
          method: "POST",
          body: JSON.stringify({
            keysText,
            defaults: {
              weight: Number(weight),
              enabled,
              alwaysTry,
            },
          }),
        }
      )
      setLoading(false)
      onOpenChange(false)
      void onSuccess(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.importFailed)
      setLoading(false)
    }
  }

  const hasInput = Boolean(keysText.trim())
  const weightValue = Number(weight)
  const validWeight = Number.isFinite(weightValue) && weightValue > 0

  function handleModeChange(value: string) {
    setMode(value as ImportMode)
    setKeysText("")
    setFileName("")
    setError("")
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUpIcon />
            {copy.importKeysTitle}
          </DialogTitle>
          <DialogDescription>
            {copy.importKeysDescription(providerName)}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{copy.importFailed}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Tabs value={mode} onValueChange={handleModeChange}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="text">{copy.importText}</TabsTrigger>
            <TabsTrigger value="file">{copy.importFile}</TabsTrigger>
          </TabsList>
          <TabsContent value="text" className="pt-3">
            <Textarea
              value={keysText}
              onChange={(event) => setKeysText(event.target.value)}
              placeholder={copy.importPlaceholder}
              className="min-h-56 resize-y font-mono text-xs"
              aria-label={copy.importText}
              disabled={loading}
            />
          </TabsContent>
          <TabsContent value="file" className="pt-3">
            <div
              className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleFileDrop}
            >
              <UploadIcon className="size-8 text-muted-foreground" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">
                  {fileName || copy.chooseFile}
                </p>
                <p className="text-xs text-muted-foreground">
                  {copy.importFileHint}
                </p>
              </div>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".txt,.json,text/plain,application/json"
                className="sr-only"
                onChange={(event) => void handleFileChange(event)}
                disabled={loading}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
              >
                <UploadIcon />
                {copy.chooseFile}
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="import-key-weight">{copy.weight}</FieldLabel>
            <Input
              id="import-key-weight"
              type="number"
              min={0}
              step="any"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              disabled={loading}
            />
          </Field>
          <Field orientation="horizontal" className="sm:col-span-2">
            <FieldContent>
              <FieldLabel>{copy.importEnabled}</FieldLabel>
              <FieldDescription>{copy.keyEnabled}</FieldDescription>
            </FieldContent>
            <Switch
              aria-label={copy.importEnabled}
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={loading}
            />
          </Field>
          <Field orientation="horizontal" className="sm:col-span-3">
            <FieldContent>
              <FieldLabel>{copy.importAlwaysTry}</FieldLabel>
              <FieldDescription>{copy.alwaysTryDescription}</FieldDescription>
            </FieldContent>
            <Switch
              aria-label={copy.importAlwaysTry}
              checked={alwaysTry}
              onCheckedChange={setAlwaysTry}
              disabled={loading}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {copy.cancel}
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!hasInput || !validWeight || loading}
          >
            {loading && <Spinner />}
            {copy.importSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
