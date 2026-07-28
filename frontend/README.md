# frontend

The shared React SPA (Vite + React + TypeScript), hosted as a static site on
S3. See [`docs/action_plan/frontend/0001-spa-scaffold-and-hosting.md`](../docs/action_plan/frontend/0001-spa-scaffold-and-hosting.md)
for the plan this was built from, and
[`.claude/rules/service-contract.md`](../.claude/rules/service-contract.md)
for the no-hardcoded-endpoint rule shared with the backend services.

This app is **not** containerized and has no server — it's a static bundle.
Hosting/deploy is handled by CD (`frontend-cd.yml`); don't hand-deploy.

## Local dev

```bash
cd frontend
npm install
npm run dev        # Vite dev server with hot reload, http://localhost:5173
```

By default the app reads `public/config.json`, which ships with
`{ "apiBaseUrl": "" }` — an empty API base URL means "no backend configured,"
and the example feature will render a graceful "backend unavailable" state
rather than crash. To point local dev at a real backend (a deployed ALB, or a
service running locally), edit `frontend/public/config.json`:

```json
{ "apiBaseUrl": "http://localhost:3000" }
```

Do **not** commit a real `apiBaseUrl` value to `public/config.json` — it's
overwritten in production by backend CD after every infra apply (see the PRD).

## Build

```bash
npm run build       # tsc -b && vite build -> frontend/dist/
npm run typecheck   # tsc --noEmit
npm run preview     # serve the built dist/ locally
```

`npm run build` produces `frontend/dist/` (static HTML/JS/CSS). CD syncs this
to the S3 website bucket, excluding `config.json` (which the backend pipeline
owns — see below).

## How the runtime API URL works

The compiled bundle never hardcodes a backend URL. Instead:

1. `src/lib/config.ts` (`loadConfig()`) fetches `/config.json` once, with
   `{ cache: 'no-store' }`, **before** the app renders (see `src/main.tsx`).
2. `getApiBaseUrl()` exposes the loaded `apiBaseUrl` to the rest of the app.
3. `src/lib/api.ts` (`apiFetch<T>`) prefixes every request with that base URL.
   If it's empty, `apiFetch` throws a clear "backend not configured" error
   that calling code (e.g. a React Query `useQuery`) turns into a graceful
   empty/error state.

In production, `public/config.json` is overwritten on S3 by the backend CD
pipeline after each infrastructure apply (it knows the current ALB URL);
`frontend-cd.yml` explicitly excludes `config.json` from its sync so a
frontend-only deploy never clobbers the live API URL.

## Add a feature (recipe)

Copy the shape of `src/features/products/` — the worked example:

1. **Create `src/features/<name>/api.ts`** — a `use<Name>s()` React Query
   `useQuery` calling `apiFetch<T>('/<resource>')`, and (if the feature
   writes data) a `useCreate<Name>()` `useMutation` that invalidates the
   query's key `onSuccess`. Add TypeScript interfaces for the payload/response
   shapes.
2. **Create `src/features/<name>/<Name>Page.tsx`** — consume those hooks.
   Handle `isLoading`, `isError` (render a graceful "backend unavailable"
   message — don't assume the API exists), and the empty-list case.
3. **Register one route** in `src/router.tsx` at the marked
   `// Register your route here.` spot — add `{ path: '<name>', element: <...> }`
   as a child of the root `Layout` route. Wrap in `<ProtectedRoute>` if the
   page should require auth.
4. **Add a nav link** in `src/Layout.tsx` if the page should be reachable from
   the shared nav.

No infra or build config changes are needed — the pipeline builds and
deploys everything under `frontend/` as-is.

## Auth

`src/auth/AuthContext.tsx` and `src/auth/ProtectedRoute.tsx` implement real
Amazon Cognito authentication — **SPA-direct** over Cognito's public HTTPS
APIs (`SignUp` / `ConfirmSignUp` / `InitiateAuth` via SRP), per
[ADR 0005](../docs/architecture/decisions/0005-cognito-auth-over-http.md) and
[PRD user/0001](../docs/action_plan/user/0001-user-service.md). There is no
Cognito hosted UI and no redirect URIs — the login/register/confirm screens
under `src/auth/` are hand-built and call
[`amazon-cognito-identity-js`](https://www.npmjs.com/package/amazon-cognito-identity-js)
directly, so the HTTPS-redirect-URI constraint that blocks the hosted UI
never applies here.

- **Config:** `public/config.json` now carries `cognitoUserPoolId` and
  `cognitoClientId` alongside `apiBaseUrl`. Both are non-secret (a pool id and
  a *public* app client id — the client has no secret to leak) and follow the
  same runtime-config seam as the API base URL (`src/lib/config.ts`). When
  either is empty — e.g. locally, or before the Cognito pool is deployed —
  `useAuth()` reports `authConfigured: false` and every auth-gated screen
  (`LoginPage`, `RegisterPage`, `ConfirmPage`, `<ProtectedRoute>`) renders a
  graceful "authentication is not configured yet" message instead of
  crashing or rendering a form that can never succeed.
- **Flow:** register (`SignUp`) → confirm the 6-digit emailed code
  (`ConfirmSignUp`) → sign in (`InitiateAuth` via SRP — the password itself
  never crosses the wire) → the SPA holds an ID/access/refresh token triple.
  `useAuth().getIdToken()` resolves the *current* session's ID token,
  transparently refreshing it via the refresh token when expired; `lib/api.ts`
  calls it on every request and attaches `Authorization: Bearer <token>` when
  a session exists (no session → no header → public endpoints keep working).
- **Token storage:** `amazon-cognito-identity-js` persists tokens in
  `localStorage` by default, and this app leaves that default in place — an
  **accepted, documented choice** ([PRD user/0001 §9.1](../docs/action_plan/user/0001-user-service.md#91-security-posture)),
  not an oversight. It means an XSS bug would expose tokens; acceptable for
  this disposable, no-real-user-data course environment, retired alongside
  the other HTTP-transport trade-offs when the deferred HTTPS/CloudFront PRD
  lands.
- **Session restore:** on mount, `AuthProvider` calls
  `userPool.getCurrentUser()?.getSession(...)`, so a page reload keeps an
  already-signed-in user signed in without re-entering credentials.
- **Profile & billing:** `src/features/users/` (`ProfilePage`, `BillingPage`)
  are the first screens built against this auth — see
  [adding-a-frontend-feature.md](../docs/operations/adding-a-frontend-feature.md)
  for the general feature recipe they follow.

## Notes

- Node 20+ recommended (matches the CI runner).
- Not added to the repo-root `docker-compose.yml` — a static SPA needs no
  container; use `npm run dev` for local development.
