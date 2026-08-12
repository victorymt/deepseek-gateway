export function toCsv(
  headers: string[],
  rows: Array<Array<unknown>>
): string {
  const escape = (value: unknown) => {
    const text = String(value ?? "")
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  return [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\r\n")
}
