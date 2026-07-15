# 0001 — React SPA Scaffold + S3 Static Hosting

> Scaffold a single Vite + React + TypeScript SPA under `frontend/` (pre-wired with React Router, React Query, a typed API/data layer, an auth stub, and one worked example feature that teammates copy), and host it as an **S3 static website over HTTP** provisioned in `app-base` (permanent, ~$0). The SPA reads the backend API URL from a **runtime `config.json`** that CD refreshes after each edge apply, so the churning ALB DNS never requires a rebuild. HTTPS/CloudFront/custom-domain/Cognito are deferred to a later PRD.

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-15
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-15 (user)

> Decisions settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the platform owner with frontend-capable teammates, I want a single shared React SPA — already wired for routing, data-fetching, and API access, with a copy-me example — hosted cheaply on S3, so that a teammate who knows React can add a page/feature without touching infra, build config, or deployment, and the app automatically finds the backend API wherever the ALB currently lives. The frontend is a **demo asset** (Part 4's "showcase the working application") beyond the graded rubric, so it must stay lean and ~$0.

## 3. Scope

**In scope:**
- **`frontend/` — a single Vite + React + TypeScript SPA** (Vite `react-ts`), pre-wired with:
  - **React Router** (`react-router-dom`) with a small route registry teammates extend, and a layout shell.
  - **React Query** (`@tanstack/react-query`) — `QueryClientProvider` at the root.
  - **Runtime config + typed API layer:** `src/lib/config.ts` (fetches `/config.json` once at startup, before render) and `src/lib/api.ts` (a typed `apiFetch<T>` wrapper that reads the API base URL from that config). No hardcoded endpoints.
  - **Auth seam/stub:** `AuthContext` + a `ProtectedRoute` wrapper that currently pass through with a mock/no-op user, with a documented spot where Cognito plugs in later.
  - **One worked example feature** under `src/features/<example>/` (a page + route + a React Query query **and** mutation hook calling the API via `apiFetch`) — the frontend analog of `services/_template`, for teammates to copy. It renders a graceful "backend unavailable" state when no service is up (there are none yet).
  - **`README.md`** documenting local dev (`npm run dev`), the build (`npm run build`), and the exact "how to add a feature" recipe (new `features/<name>/`, register one route).
- **`terraform/modules/frontend/`** — an S3 static-website bucket in **`app-base`**: `aws_s3_bucket` (`soa-frontend-<account_id>`, globally-unique), `aws_s3_bucket_website_configuration` (index **and** error document = `index.html`, so client-side routing survives refresh), `aws_s3_bucket_public_access_block` (disabled for this bucket), and a public-read `aws_s3_bucket_policy` (`s3:GetObject` to `*` on the bucket's objects). Wired into `terraform/app-base/main.tf`; `app-base` outputs the bucket name + website endpoint.
- **IAM (human-applied, `terraform/iam.tf`):** grant `soa-deployer` **scoped** S3 permissions on `arn:aws:s3:::soa-frontend-*` only — bucket create/read/manage (create bucket, put/get website config, put/get bucket policy, put/get public-access-block, tagging, the bucket-attribute reads Terraform refreshes) and object read/write/delete/list (for the SPA files + `config.json`). No broader S3 access.
- **`frontend-cd.yml`** (new workflow) — on push to `main` touching `frontend/**`: `npm ci` → `npm run build` → `aws s3 sync frontend/dist/ s3://soa-frontend-…/ --delete --exclude config.json` (keyless OIDC as `soa-deployer`). A matching **PR check** runs `npm ci` + `npm run build` + typecheck (no deploy).
- **Backend `cd.yml` addition** — after the `app-edge` apply, a step that reads the ALB DNS (`terraform output`), writes `{"apiBaseUrl":"http://<alb>"}` to `s3://soa-frontend-…/config.json` with `--cache-control no-cache`. The backend owns `config.json` (it knows the API URL); the frontend sync excludes it.
- **Docs:** an ADR for the S3-HTTP-hosting + runtime-`config.json` decision; `overview.md` frontend section; a "adding a frontend feature" operations doc; `cost-lifecycle.md` note that the frontend is always-on in base.

**Out of scope (a later "frontend HTTPS + auth" PRD):**
- **CloudFront, HTTPS, a custom domain (Route 53 + ACM)** — blocked today because the API is HTTP-only (an HTTPS SPA can't call an HTTP API — mixed content). Deferred as one coherent upgrade.
- **Real Cognito auth** (needs HTTPS redirect URIs) — only the stub seam lands now.
- **Backend-for-frontend (BFF) service** — explicitly not built (another billable ECS service, beyond rubric).
- **Actual product features / real API round-trip** — arrives when the first backend service (Order/Product/User) is built via `/new-service`.

## 4. Success criteria

1. `frontend/` exists as a Vite + React + TS app; `cd frontend && npm ci && npm run build` produces `dist/` and `npm run typecheck` (tsc) passes clean.
2. The SPA is pre-wired: multiple React Router routes (routing survives a hard refresh in the deployed site), `QueryClientProvider` present, `src/lib/config.ts` + `src/lib/api.ts` implement the runtime-config + typed-fetch pattern, an `AuthContext`/`ProtectedRoute` stub exists, and one worked example feature demonstrates a React Query query + mutation via `apiFetch`. `README.md` documents the add-a-feature recipe.
3. `terraform/modules/frontend/` creates the website bucket (index+error = `index.html`, public-read policy, public-access-block disabled) and is wired into `app-base`; `terraform -chdir=terraform/app-base validate` passes.
4. `soa-deployer` gains S3 permissions scoped to `soa-frontend-*` **only** (no account-wide S3); infra-reviewer confirms the public-read bucket is intentional/scoped and nothing else is exposed.
5. `frontend-cd.yml` builds + syncs on `frontend/**` (keyless OIDC); backend `cd.yml` refreshes `config.json` after the edge apply; a frontend PR check builds/typechecks without deploying.
6. **Deployed & verified:** the SPA loads at the S3 website endpoint over HTTP; deep-linking/refresh on a React Router route serves the app (not a 404); the browser fetches `/config.json` at startup; the example feature renders and attempts its API call (graceful state, since no backend service exists yet).
7. **No secrets, no hardcoded endpoints:** a grep of `frontend/dist/` finds no secrets/keys; a grep of `frontend/src/` finds no literal `elb.amazonaws.com`/API URL — the API base URL comes only from runtime `config.json`.
8. **Always-on at ~$0:** the frontend lives in `app-base`; `terraform -chdir=terraform/app-edge destroy` does **not** remove it, and the SPA still loads afterward (API calls just fail gracefully). No new billable resource.

## 5. Resources

| Resource | Type | Config | Cost |
| --- | --- | --- | --- |
| Website bucket | `aws_s3_bucket` (`soa-frontend-<acct>`) | app-base | **$0** (few MB, free-tier) |
| Website config, public-access-block, bucket policy | `aws_s3_bucket_website_configuration` / `_public_access_block` / `_policy` | app-base | **$0** |
| SPA static assets + `config.json` | S3 objects | app-base | **$0** |
| `soa-deployer` scoped S3 grant | `aws_iam_policy` stmts (`s3:*` on `soa-frontend-*`) | terraform/ root | **$0** |
| `frontend/` app + `frontend-cd.yml` | repo files / workflow | — | **$0** |
| SPA GET requests + data transfer | — | — | **$0** (free-tier: 20k GETs, 100 GB egress/mo) |

**Total: ~$0.** No new billable resource — S3 static hosting for a small SPA sits inside the free tier. This PRD's execution stands the frontend up permanently (in base) and briefly brings the edge up to verify the config plumbing, then destroys the edge — net ~$0. HTTP-only, no CloudFront/domain, so no CDN or certificate cost.

## 6. Scripts / commands

```bash
# --- Scaffold + local build (app-engineer) ---
cd frontend && npm ci && npm run build      # produces frontend/dist/
npm run typecheck                            # tsc --noEmit

# --- Terraform (terraform-engineer; validate only, never apply) ---
terraform -chdir=terraform/app-base validate

# --- One-time IAM (human-applied, admin creds): deployer gains scoped S3 on soa-frontend-* ---
terraform -chdir=terraform apply

# --- Ship it (PR -> CI -> merge -> CD) ---
git checkout -b frontend-spa
git add -A && git commit -m "Scaffold React SPA + S3 static hosting (PRD frontend/0001)"
git push -u origin frontend-spa
# PR -> CI (validate/plan app-base incl. frontend bucket; frontend build/typecheck) -> merge
# -> backend CD applies app-base (creates the bucket) + app-edge; frontend-CD builds + syncs the SPA

# --- Verify the deployed SPA (read-only) ---
aws s3 website ... # or: open the app-base `frontend_website_endpoint` output in a browser
#   confirm: SPA loads over HTTP, refresh on a route works, /config.json is fetched

# --- Edge stays destroyable; frontend (base) stays up ---
terraform -chdir=terraform/app-edge destroy  # SPA still loads; API calls fail gracefully -> ~$0
```

Billable/destructive commands named: the transient `app-edge` apply/destroy for verification. Creating the S3 bucket and syncing the SPA are free.

## 7. Planned agents

- **`app-engineer`** — scaffold `frontend/` (Vite react-ts): router, React Query provider, `lib/config.ts` + `lib/api.ts`, the auth stub, the worked example feature, `README.md`; wire `main.tsx` to `await loadConfig()` before render; ensure `npm ci && npm run build && npm run typecheck` pass. Ship a default/fallback `config.json` handling so the app degrades gracefully when the backend is down.
- **`terraform-engineer`** — create `terraform/modules/frontend/` (bucket + website + public-access-block + policy), wire it into `app-base/main.tf` + outputs (bucket name, website endpoint); add the **scoped** `soa-frontend-*` S3 statements to `terraform/iam.tf` (human-applied). `fmt`/`validate`; never apply.
- **`pipeline-engineer`** — create `frontend-cd.yml` (build + `s3 sync --exclude config.json`) + the frontend PR build/typecheck check; add the `config.json` refresh step to backend `cd.yml` after the edge apply. Keyless OIDC, no long-lived keys.
- **`infra-reviewer`** — audit: the deployer's new S3 grant is scoped to `soa-frontend-*` only (no account-wide S3, no state-bucket overlap); the public-read bucket exposes only the SPA (no other data); `config.json` carries no secrets; no hardcoded endpoints; keyless intact.
- **`documentation-keeper`** — ADR (S3-HTTP hosting + runtime `config.json`, HTTPS deferred + why/mixed-content); `overview.md` frontend section; an `adding-a-frontend-feature.md` operations doc; `cost-lifecycle.md` + `compute-layer.md` notes that the frontend is always-on in base.
- **Main session** — writes this PRD; orchestrates; performs the one-time human `terraform apply` (root IAM); drives the PR + verification.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 builds | `cd frontend && npm ci && npm run build` → `dist/` exists; `npm run typecheck` clean |
| #2 pre-wired | review router/Query/config/api/auth-stub/example; `README` has the add-a-feature recipe |
| #3 terraform | `terraform -chdir=terraform/app-base validate`; module wired + outputs present |
| #4 IAM scope | infra-reviewer confirms `soa-frontend-*`-only S3 grant; public-read intentional |
| #5 pipeline | inspect `frontend-cd.yml` (build+sync, excludes config.json) + backend `cd.yml` config.json step + PR check; keyless |
| #6 deployed | open the website endpoint: SPA loads (HTTP), refresh-on-route works, `/config.json` fetched (devtools), example feature renders |
| #7 clean bundle | `grep -rI` `dist/` for secrets → none; `grep -rI "elb.amazonaws.com"` `frontend/src` → none |
| #8 $0 / survives teardown | after `app-edge destroy`: SPA still loads; `aws s3 ls` shows the bucket; base `plan` = 0 changes |

## 9. Additional considerations

- **Security posture — public-read bucket (accepted):** static-website hosting requires the bucket be public-read. This is acceptable because the bucket holds **only** the compiled SPA (public HTML/JS/CSS) and `config.json` (a non-secret API URL) — **no secrets, no credentials** ever go in the bundle or the bucket. The deployer's new S3 grant is scoped to `soa-frontend-*`, so it cannot touch the state bucket or any other S3. Documented as a deliberate exception to the private-by-default posture.
- **Deployer gains scoped S3 (like the DynamoDB grant):** because the bucket lives in pipeline-applied `app-base`, `soa-deployer` needs S3 create/manage/object powers on `soa-frontend-*`. Human-applied `terraform/iam.tf` change (the deployer can't modify its own IAM), scoped by name prefix. infra-reviewer verifies the scope.
- **HTTP-only is a known limitation:** fine for a demo URL; the browser shows "Not secure." Real use needs the deferred HTTPS PRD (CloudFront + Route 53 + ACM), which is also the prerequisite for Cognito — hence auth is a stub now. The no-hardcoded-endpoint + runtime-`config.json` design means that upgrade is mostly an infra change, not a frontend rewrite.
- **No backend to call yet:** the example feature proves the plumbing (config → api → React Query) but shows a graceful empty/error state until the first real service (Order/Product/User) lands via `/new-service`. First real round-trip is verified then.
- **`config.json` freshness:** written by backend CD with `--cache-control no-cache`; the frontend sync excludes it so a SPA redeploy never clobbers the live API URL. Hashed JS/CSS assets are cache-forever; `index.html` is `no-cache` so new deploys appear immediately.
- **Local dev:** `npm run dev` (Vite dev server, hot reload) — not containerized (a static SPA needs no Docker image). Teammates point at a deployed ALB or a local backend via a local `public/config.json`.
- **Rollback/teardown:** all changes are files or free S3 resources. The frontend is intentionally **not** part of the destroy-to-$0 edge cycle; at true project end it's removed by destroying `app-base` (or emptying+deleting the bucket).

---

## Outcome

Executed as planned and proven end-to-end. Shipped in PR #12 (`Scaffold React SPA + S3 static hosting`), merged to `main`.

**Delivered:**
- `frontend/` — Vite + React + TypeScript SPA: React Router, React Query, the runtime-`config.json` + typed `apiFetch` layer, an auth stub (`AuthContext`/`ProtectedRoute`, `// TODO(cognito)` markers), one worked `products` example feature, and a README with the add-a-feature recipe. Builds + typechecks clean.
- `terraform/modules/frontend/` — public-read S3 website bucket (`soa-frontend-<acct>`, index+error = `index.html`), wired into `app-base` with `frontend_bucket_name`/`frontend_website_endpoint` outputs. `soa-deployer` gained S3 scoped to `soa-frontend-*` only — no `s3:DeleteBucket`, plus an explicit `DenyFrontendBucketDeletion` backstop.
- `frontend-cd.yml` (build → `s3 sync --exclude config.json` → `index.html` no-cache), `frontend-ci.yml` (PR build/typecheck), and the `config.json` refresh step in backend `cd.yml`. ADR 0004, `adding-a-frontend-feature.md`, overview/cost/pipeline doc updates.

**Verification (all criteria met):**
- CI green on PR #12: Terraform fmt/validate/plan on both configs **and** the new Frontend build/typecheck check.
- Root IAM apply → `0 add, 1 change`. `app-base` apply → **5 added** (bucket + ownership controls + website config + public-access-block + policy), all free.
- Frontend CD **succeeded** (built + synced the SPA); backend CD **succeeded** (applied base + edge, then the **"Refresh frontend config.json"** step wrote the live ALB DNS).
- Live checks against the S3 website endpoint: `GET /` → **200** (SPA loads), `GET /config.json` → **`{"apiBaseUrl":"http://soa-alb-…"}`** (the real ALB DNS, proving the dynamic-URL plumbing), `GET /products` → serves `index.html` (client-side routing survives refresh; 404 status is the documented S3 quirk). Criteria #1–7.
- After `app-edge destroy`: **0 ALBs** (~$0), SPA **still loads (200)**, frontend bucket present, `app-base plan` → **"No changes"**. Criterion #8 — frontend survives the edge teardown at ~$0.

**Deviations (all improvements / bootstrap, no scope/cost change):**
- **Made the no-hardcoded-endpoint rule a real CI check.** infra-reviewer found the docs claimed "CI-enforced" but no grep existed. Added a real grep guard to `ci.yml` (`services/`+`functions/`) and `frontend-ci.yml` (`frontend/src`) so the claim is now true.
- **Added a CORS contract item** (`service-contract.md` app-contract item 7) per infra-reviewer's forward-flag: the first browser-facing service must return CORS headers, or the SPA's cross-origin `fetch` (S3 origin → ALB origin) is browser-blocked even when the ALB is reachable. Captured in ADR 0004 too.
- **One-time bootstrap:** `app-base` (with the new frontend module) was applied locally before the PR so the frontend pipeline could resolve the bucket output on merge without a race — consistent with base being human-first-applied.
- Minor (flagged, not fixed): `vite.config.ts` `build.target: es2022` (for top-level `await loadConfig()`); one moderate `npm audit` finding in `vite@5`'s dev server only (not the S3-hosted output).

**Follow-ups:** the deferred **HTTPS + CloudFront + custom domain + Cognito** PRD (the runtime-`config.json` design makes it an infra change, not a frontend rewrite); **CORS** config lands with the first `/new-service`; the first real domain service exercises the actual API round-trip (today the example shows a graceful "backend unavailable" state).

**Steady state now:** the SPA is **always-on in `app-base` at ~$0** with a stable URL (`soa-frontend-<acct>.s3-website-us-east-1.amazonaws.com`), reachable even between sessions; only the edge (ALB) cycles up/down. See [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md) and [cost-lifecycle.md](../../operations/cost-lifecycle.md).
