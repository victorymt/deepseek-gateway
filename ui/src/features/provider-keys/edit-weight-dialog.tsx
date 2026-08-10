import { useId, useState, type FormEvent } from "react"
import { PencilIcon } from "lucide-react"

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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

import type { ProviderKeyCopy } from "./types"

export function EditWeightDialog({
  providerId,
  keyName,
  weight,
  copy,
  disabled,
  pending,
  onSubmit,
}: {
  providerId: string
  keyName: string
  weight: number
  copy: ProviderKeyCopy
  disabled: boolean
  pending: boolean
  onSubmit: (weight: number) => Promise<boolean>
}) {
  const inputId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(weight))
  const [error, setError] = useState("")

  function openDialog() {
    setDraft(String(weight))
    setError("")
    setOpen(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextWeight = Number(draft)
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
      setError(copy.weightInvalid)
      return
    }
    setError("")
    if (await onSubmit(nextWeight)) setOpen(false)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copy.editWeight}
        title={copy.editWeight}
        disabled={disabled}
        onClick={openDialog}
      >
        <PencilIcon />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.editWeight}</DialogTitle>
            <DialogDescription>
              {providerId} · {keyName}
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <FieldGroup>
              <Field data-invalid={Boolean(error) || undefined}>
                <FieldLabel htmlFor={inputId}>{copy.weight}</FieldLabel>
                <Input
                  id={inputId}
                  type="number"
                  min="0.1"
                  step="0.1"
                  required
                  value={draft}
                  aria-invalid={Boolean(error)}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setError("")
                  }}
                />
                {error && <FieldError>{error}</FieldError>}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                {copy.saveWeight}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
