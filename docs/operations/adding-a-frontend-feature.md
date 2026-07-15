# Adding a Frontend Feature

How a teammate adds a page/feature to the shared React SPA — the frontend analog of [adding-a-service.md](adding-a-service.md). No infra or build-config changes are needed; the pipeline builds and deploys everything under `frontend/` as-is once a route is registered.

Built by [PRD frontend/0001](../action_plan/frontend/0001-spa-scaffold-and-hosting.md); hosting decision recorded in [ADR 0004](../architecture/decisions/0004-frontend-hosting.md). Worked example: [`frontend/src/features/products/`](../../frontend/src/features/products/). This doc summarizes the recipe already in [`frontend/README.md`](../../frontend/README.md) — that file is the source of truth for exact commands; keep the two in sync if either changes.

## 1. The runtime API-URL model (read this first)

The compiled SPA never hardcodes a backend URL — the same no-hardcoded-endpoint rule the backend services follow ([`service-contract.md`](../../.claude/rules/service-contract.md)), extended to the frontend by [ADR 0004](../architecture/decisions/0004-frontend-hosting.md):

- `frontend/src/lib/config.ts` fetches `/config.json` once, before the app renders (`frontend/src/main.tsx` awaits `loadConfig()`).
- `frontend/src/lib/api.ts`'s `apiFetch<T>(path, init?)` reads the loaded `apiBaseUrl` at call time and prefixes every request with it. If it's empty (no backend configured), `apiFetch` throws a clear "backend not configured" error instead of a raw network failure.
- **Always call the API through `apiFetch`**, never a bare `fetch()` to a literal URL. A grep for a hardcoded ALB DNS name (`elb.amazonaws.com`) in `frontend/src/` is part of the project's success criteria for this pattern.
- In production, `public/config.json` on S3 is owned and overwritten by the **backend** `cd.yml` after every `app-edge` apply (it's the only workflow that knows the current ALB URL); locally, `frontend/public/config.json` ships with `{ "apiBaseUrl": "" }` by default — edit it to point at a real backend for local testing, but never commit a real value (see [`frontend/README.md`](../../frontend/README.md#local-dev)).

Because of this, a feature that calls the API must handle the "not configured" / "unreachable" states gracefully (loading/error/empty states) rather than assuming the backend exists — there may be no backend service deployed yet.

## 2. Add a feature (recipe)

Copy the shape of [`src/features/products/`](../../frontend/src/features/products/):

1. **Create `frontend/src/features/<name>/api.ts`** — TypeScript interfaces for the payload/response shapes, a `use<Name>s()` React Query `useQuery` calling `apiFetch<T>('/<resource>')`, and (if the feature writes data) a `useCreate<Name>()` `useMutation` that invalidates the query's key `onSuccess`.
2. **Create `frontend/src/features/<name>/<Name>Page.tsx`** — a page component that consumes those hooks. Handle `isLoading`, `isError` (render a graceful "backend unavailable" message, don't assume the API exists), and the empty-list case.
3. **Register one route** in [`frontend/src/router.tsx`](../../frontend/src/router.tsx), at the marked `// Register your route here.` spot — add `{ path: '<name>', element: <YourPage /> }` as a child of the root `Layout` route. Wrap the element in `<ProtectedRoute>` (from `frontend/src/auth/ProtectedRoute.tsx`) if the page should require auth — currently a stub that always passes through (see §3).
4. **Add a nav link** in [`frontend/src/Layout.tsx`](../../frontend/src/Layout.tsx) if the page should be reachable from the shared nav.

No Terraform, Dockerfile, or pipeline change is required — `frontend-cd.yml` builds and deploys everything under `frontend/` as one unit on every push to `main` that touches `frontend/**`.

## 3. Auth is a stub — don't build against real Cognito yet

`frontend/src/auth/AuthContext.tsx` (`useAuth()`) and `frontend/src/auth/ProtectedRoute.tsx` are a deliberate stub: a mock signed-in user, always-allow routing. Real Amazon Cognito integration is deferred until the HTTPS/CloudFront PRD lands (Cognito's hosted UI requires HTTPS redirect URIs — see [ADR 0004](../architecture/decisions/0004-frontend-hosting.md)). Code consuming `useAuth()`/`<ProtectedRoute>` is written against the real shape already, so it should not need to change when Cognito is wired in — look for `// TODO(cognito):` comments marking the exact spots that will.

## 4. Local development

```bash
cd frontend
npm install
npm run dev         # Vite dev server, http://localhost:5173, hot reload
npm run build        # tsc -b && vite build -> frontend/dist/
npm run typecheck    # tsc --noEmit
npm run preview      # serve the built dist/ locally
```

Not containerized and not added to the repo-root `docker-compose.yml` — a static SPA needs no Docker image or server process; `npm run dev` is the whole local loop. To exercise a real API call locally, point `frontend/public/config.json` at a deployed ALB (`terraform -chdir=terraform/app-edge output alb_dns_name`) or a locally running service, per [`frontend/README.md`](../../frontend/README.md#local-dev).

## 5. Deploying

Deploy is automatic — there is no manual step:

1. Push a commit touching `frontend/**` to a branch, open a PR into `main`.
2. `frontend-ci.yml` runs (`npm ci && npm run build && npm run typecheck`) as a PR check — build/typecheck only, no AWS auth, no deploy. This is additive to (does not replace) the existing required "Terraform fmt / validate / plan" check.
3. Merge → `frontend-cd.yml` runs on push to `main` (path-filtered to `frontend/**`): builds the SPA, resolves the S3 bucket name via `terraform output` against `terraform/app-base` (read-only — this workflow never applies Terraform), and `aws s3 sync frontend/dist/ s3://<bucket>/ --delete --exclude config.json` as `soa-deployer` over keyless OIDC, then re-marks `index.html` `--cache-control no-cache` so the new deploy is visible immediately (hashed JS/CSS assets are cache-forever by default).

See [operations/cicd-pipeline.md](cicd-pipeline.md#8-frontend-workflows) for the workflow details and how this relates to the backend `cd.yml`'s `config.json` refresh step.

## Related docs

- [`frontend/README.md`](../../frontend/README.md) — the source-of-truth local dev / build / recipe doc this operations doc summarizes.
- [ADR 0004 — Frontend Hosting](../architecture/decisions/0004-frontend-hosting.md) — why S3 + runtime `config.json`, and why HTTPS/auth are deferred.
- [architecture/overview.md](../architecture/overview.md) — the Frontend section, how this fits the base/edge split.
- [operations/cicd-pipeline.md](cicd-pipeline.md) — the `frontend-ci.yml`/`frontend-cd.yml` workflows and the backend `config.json` refresh step.
- [operations/cost-lifecycle.md](cost-lifecycle.md) — why the frontend survives `app-edge` teardown.
- [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md) — the no-hardcoded-endpoint rule shared with backend services.
- [PRD frontend/0001](../action_plan/frontend/0001-spa-scaffold-and-hosting.md) — the plan and outcome this recipe was built from.
