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

## Auth (stub)

`src/auth/AuthContext.tsx` and `src/auth/ProtectedRoute.tsx` are a stub: a
mock signed-in user, always-allow routes. Real Amazon Cognito auth is
deferred to a later PRD (needs HTTPS redirect URIs). Look for
`// TODO(cognito):` comments marking where the real integration plugs in —
consuming code (`useAuth()`, `<ProtectedRoute>`) is not expected to change.

## Notes

- Node 20+ recommended (matches the CI runner).
- Not added to the repo-root `docker-compose.yml` — a static SPA needs no
  container; use `npm run dev` for local development.
