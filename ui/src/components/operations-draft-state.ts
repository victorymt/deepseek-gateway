export function draftAfterSubmit<T>(
  current: T | null,
  submitted: T,
  saved: boolean
): T | null {
  return saved && current === submitted ? null : current
}
