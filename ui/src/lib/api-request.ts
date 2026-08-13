export class ApiRequestError extends Error {
  status: number
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.payload = payload
  }
}

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
      throw new ApiRequestError(
        `HTTP ${response.status}: invalid JSON response`,
        response.status,
        null
      )
    }
  } else if (response.ok) {
    throw new ApiRequestError(
      `HTTP ${response.status}: expected JSON response`,
      response.status,
      null
    )
  }
  if (!response.ok) {
    throw new ApiRequestError(
      payload.error?.message || `HTTP ${response.status}`,
      response.status,
      payload
    )
  }
  return payload as T
}
