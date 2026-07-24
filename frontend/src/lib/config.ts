// Runtime configuration loaded from /config.json at app startup.
//
// This file is deliberately fetched at runtime (not baked into the build) so
// the compiled SPA never hardcodes the backend API URL. In production,
// backend CD overwrites public/config.json on S3 with the live ALB URL after
// every infra apply; locally (or if the fetch fails) we fall back to the
// shipped default of an empty apiBaseUrl, which api.ts treats as
// "backend not configured" rather than crashing the app.

export interface AppConfig {
  apiBaseUrl: string;
  /** Cognito user pool id (region-prefixed). Empty = auth not configured. */
  cognitoUserPoolId: string;
  /** Cognito public app client id (no secret — see ADR 0005). Empty = auth not configured. */
  cognitoClientId: string;
}

const DEFAULT_CONFIG: AppConfig = {
  apiBaseUrl: '',
  cognitoUserPoolId: '',
  cognitoClientId: '',
};

let cachedConfig: AppConfig = DEFAULT_CONFIG;
let loaded = false;

/**
 * Fetches /config.json once at startup. Must be awaited before the app
 * renders (see main.tsx). Never throws — a missing/invalid config.json
 * degrades to the default (empty apiBaseUrl) so the app still boots.
 */
export async function loadConfig(): Promise<AppConfig> {
  if (loaded) {
    return cachedConfig;
  }

  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`config.json fetch failed: ${response.status}`);
    }
    const parsed = (await response.json()) as Partial<AppConfig>;
    cachedConfig = {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '',
      cognitoUserPoolId:
        typeof parsed.cognitoUserPoolId === 'string' ? parsed.cognitoUserPoolId : '',
      cognitoClientId: typeof parsed.cognitoClientId === 'string' ? parsed.cognitoClientId : '',
    };
  } catch (err) {
    // Expected when the backend/edge isn't deployed, or config.json is
    // missing locally — fall back gracefully rather than blocking render.
    console.warn('[config] falling back to default config:', err);
    cachedConfig = DEFAULT_CONFIG;
  } finally {
    loaded = true;
  }

  return cachedConfig;
}

/** Returns the currently loaded API base URL (empty string if unconfigured). */
export function getApiBaseUrl(): string {
  return cachedConfig.apiBaseUrl;
}

/**
 * Returns the currently loaded Cognito pool/client ids. Both are empty
 * strings when the pool hasn't been provisioned/wired yet (see
 * PRD platform/0009) — callers should treat that as "auth not configured"
 * rather than an error (PRD user/0001 §4.6).
 */
export function getCognitoConfig(): { userPoolId: string; clientId: string } {
  return { userPoolId: cachedConfig.cognitoUserPoolId, clientId: cachedConfig.cognitoClientId };
}
