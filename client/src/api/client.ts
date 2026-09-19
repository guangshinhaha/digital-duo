import type { ApiError } from "./types.js";

/** Thrown for any non-2xx response, carrying the daemon's own error shape (`client-tech-design.md` §1.5: `{ error: { code, message } }`) so callers can branch on `code` without parsing prose. */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, body: ApiError | undefined) {
    super(body?.error.message ?? `Request failed with status ${status}`);
    this.name = "ApiRequestError";
    this.code = body?.error.code ?? "unknown";
    this.status = status;
  }
}

export interface DuoApiConfig {
  /** The daemon's base URL, e.g. `http://100.64.1.5:7717`. Never defaults to localhost in production — client-design.md §1.1: the phone reaches the Mac over the tailnet, not loopback. */
  baseUrl: string;
  /** The bearer token minted by `duo pair` for this device. */
  token: string;
}

/**
 * The one function every API call goes through. No per-resource client
 * class: the daemon's route surface is small and flat, and one function
 * plus `src/api/types.ts`'s types is enough to keep every call fully
 * typed without generating or maintaining a client SDK.
 */
export async function apiRequest<T>(config: DuoApiConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let body: ApiError | undefined;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      body = undefined;
    }
    throw new ApiRequestError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
