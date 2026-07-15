import { getApiBaseUrl } from './config';

// Typed fetch wrapper for calling backend microservices. The base URL is
// resolved at call time from runtime config (never hardcoded) — see
// lib/config.ts. Every feature's api.ts should call through this rather than
// using fetch() directly, so error handling and the base-URL seam stay
// consistent.

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
    try {
      detail = await response.text();
    } catch {
      // ignore — body may be empty or unreadable
    }
    throw new ApiError(
      `Request to ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
