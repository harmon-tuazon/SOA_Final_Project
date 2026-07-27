import { getApiBaseUrl } from './config';

// Typed fetch wrapper for calling backend microservices. The base URL is
// resolved at call time from runtime config (never hardcoded) — see
// lib/config.ts. Every feature's api.ts should call through this rather than
// using fetch() directly, so error handling and the base-URL seam stay
// consistent.

export class ApiError extends Error {
  status: number;
  /** Parsed JSON error body, when the response was valid JSON (e.g. `{ error: '...' }`). */
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Pulls a human-readable message out of a thrown error: prefers a service's
 * `{ error: string }` JSON body (e.g. the 409 a stock adjustment returns),
 * falls back to the error's own message, then to `fallback`.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (
    err instanceof ApiError &&
    err.body &&
    typeof err.body === 'object' &&
    'error' in err.body &&
    typeof (err.body as { error: unknown }).error === 'string'
  ) {
    return (err.body as { error: string }).error;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return fallback;
}

/**
 * Fetches `path` against the configured API base URL, parses JSON, and
 * throws on network failure or a non-2xx response.
 *
 * Throws a clear "backend not configured" error when no apiBaseUrl has been
 * set (e.g. no backend deployed yet) so callers can render a graceful empty
 * state instead of a confusing network error.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    throw new Error('Backend not configured: apiBaseUrl is empty (no API deployed yet)');
  }

  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new Error(`Backend unavailable: could not reach ${url}`, { cause: err });
  }

  if (!response.ok) {
    let detail = '';
    let parsedBody: unknown;
    try {
      detail = await response.text();
      parsedBody = detail ? JSON.parse(detail) : undefined;
    } catch {
      // ignore — body may be empty, unreadable, or not JSON
    }
    throw new ApiError(
      `Request to ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      parsedBody,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
