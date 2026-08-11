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
  const contentType = response.headers.get("content-type") || ""
  let payload: { error?: { message?: string } } = {}
  if (contentType.includes("application/json")) {
    try {
      payload = (await response.json()) as typeof payload
    } catch {
      throw new Error(`HTTP ${response.status}: invalid JSON response`)
    }
  } else if (response.ok) {
    throw new Error(`HTTP ${response.status}: expected JSON response`)
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `HTTP ${response.status}`)
  }
  return payload as T
}
