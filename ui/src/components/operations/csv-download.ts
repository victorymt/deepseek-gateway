import { toCsv } from "@/components/operations-export"

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>
) {
  const content = toCsv(headers, rows)
  const link = document.createElement("a")
  link.href = URL.createObjectURL(
    new Blob([`\ufeff${content}`], { type: "text/csv;charset=utf-8" })
  )
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
