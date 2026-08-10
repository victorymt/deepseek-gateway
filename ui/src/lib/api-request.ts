export async function apiRequest<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `HTTP ${response.status}`)
  }
  return payload as T
}
