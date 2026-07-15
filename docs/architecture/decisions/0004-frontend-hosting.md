# 0004 — Frontend Hosting: S3 Static Website + Runtime `config.json`

> Host the React SPA as an **S3 static website over plain HTTP**, provisioned in the permanent `app-base` config, with the backend API URL resolved at **runtime from a `config.json` object** the SPA fetches on startup — rather than baking a URL into the build. HTTPS, CloudFront, a custom domain, and real Cognito auth are deferred to one later, coherent PRD.

- **Status:** Accepted
- **Date:** 2026-07-15

## Context

[PRD frontend/0001](../../action_plan/frontend/0001-spa-scaffold-and-hosting.md) adds a demo frontend: Part 4 of the project asks the team to "showcase the working application," which is beyond the graded rubric and must stay lean and effectively free, consistent with this project's cost posture ([ADR 0001](0001-platform-and-compute-architecture.md)).

Two constraints shape the hosting choice:

- **The backend API is HTTP-only.** The shared ALB ([ADR 0001](0001-platform-and-compute-architecture.md), [ADR 0003](0003-base-edge-split.md)) has no TLS certificate or custom domain — it's a bare `http://` DNS name. An HTTPS-served page calling an `http://` API hits the browser's mixed-content block, so an HTTPS frontend cannot work against today's backend without first solving TLS on the API side.
- **The ALB's DNS name is not stable.** Per [ADR 0003](0003-base-edge-split.md), `app-edge` (the ALB) is destroyed and recreated on every cost-saving teardown cycle, and each new `aws_lb` gets a new DNS name. The project already has a binding rule against hardcoding that endpoint anywhere ([`service-contract.md`](../../../.claude/rules/service-contract.md)) — the frontend has to obey the same rule, which means the API URL cannot be a build-time constant.

Given those two constraints, the real decision is not "S3 vs. something else" so much as "what's the smallest hosting model that (a) needs no TLS story yet, and (b) can pick up a changing API URL without a rebuild."

## Decision

**Host the compiled SPA on S3 static-website hosting, served over plain HTTP, in `app-base`.**

- `terraform/modules/frontend/` creates one `aws_s3_bucket`, an `aws_s3_bucket_website_configuration` with **both index and error document set to `index.html`** (so a hard refresh or deep link on a React Router route — e.g. `/products`, which has no matching S3 key — still resolves to the SPA shell, and the client-side router takes over), a public-access-block with all four flags disabled, and a bucket policy granting `s3:GetObject` to `*` on the bucket's objects only (no `s3:ListBucket`, no write). See [`terraform/modules/frontend/main.tf`](../../../terraform/modules/frontend/main.tf).
- The module is wired into `terraform/app-base/main.tf`, not `app-edge` — the bucket is **permanent and free**, so it is never touched by the routine `terraform -chdir=terraform/app-edge destroy` teardown cycle (see [ADR 0003](0003-base-edge-split.md)).
- **The API base URL is resolved at runtime, not build time.** `frontend/src/lib/config.ts` fetches `/config.json` once, before the app renders (`frontend/src/main.tsx`); `frontend/src/lib/api.ts`'s `apiFetch<T>` reads the loaded base URL on every call. Backend `cd.yml` writes the live ALB DNS into `s3://<frontend-bucket>/config.json` as its last step after every `app-edge` apply; `frontend-cd.yml` (the frontend's own build+sync workflow) explicitly excludes `config.json` from its `aws s3 sync --delete`, so a frontend-only deploy can never clobber the live API URL, and a backend-only deploy can update the URL without a frontend rebuild.
- **Stack choices that ride along with this decision:** TypeScript + Vite (`frontend/`, scaffolded `react-ts`), React Router for client-side routing, React Query for data-fetching/caching, an in-app typed API layer (`lib/api.ts`) rather than calling `fetch` ad hoc from feature code, and an auth **stub** (`src/auth/AuthContext.tsx`, `src/auth/ProtectedRoute.tsx`) that always reports a signed-in mock user. These are documented in depth in [`frontend/README.md`](../../../frontend/README.md) and [operations/adding-a-frontend-feature.md](../../operations/adding-a-frontend-feature.md); this ADR records only that the runtime-config seam is why the auth stub had to stay a stub (see below).

### Why HTTPS is deferred, and why that also defers auth

An HTTPS-served SPA cannot call an HTTP API (mixed content) — so serving the SPA over HTTPS today would require solving TLS for the *API* first, which means a CDN/edge in front of the ALB (or a cert + domain on the ALB itself), which is real infrastructure (CloudFront, Route 53, ACM) with its own PRD-worthy scope. Rather than half-solve it now, HTTPS is deferred as **one coherent later PRD** that adds CloudFront + a custom domain + ACM together, so the SPA and the API move to HTTPS in the same step and mixed content never becomes a problem in between.

Amazon Cognito requires HTTPS redirect URIs for its hosted UI — it cannot be wired against an HTTP-only site. Since that HTTPS PRD is deferred, so is real Cognito integration; only the seam (`useAuth()`, `<ProtectedRoute>`, `// TODO(cognito):` markers) is scaffolded now, so consuming code doesn't need to change shape when Cognito lands.

## Consequences

- **The bucket is deliberately public-read** — a scoped, accepted exception to this project's private-by-default data posture (per [ADR 0001](0001-platform-and-compute-architecture.md)). This is acceptable *only* because the bucket holds exactly two kinds of object: the compiled SPA bundle (public HTML/JS/CSS, meant to be served to anyone) and `config.json` (a non-secret API base URL) — never credentials, tokens, or application data. `soa-deployer`'s S3 grant (`terraform/iam.tf`) is scoped to `arn:aws:s3:::soa-frontend-*` only, with an explicit `Deny` on `s3:DeleteBucket` — the deployer can manage bucket config and objects but cannot delete the bucket itself, and this grant does not extend to the Terraform state bucket or any other S3 resource.
- **HTTP-only is a known, visible limitation.** The browser marks the site "Not secure." Acceptable for a course-project demo; not acceptable to leave permanently, which is why the deferred HTTPS PRD is named explicitly rather than left implicit.
- **The frontend sits outside the destroy-to-$0 edge cycle.** Because it lives in `app-base`, `terraform -chdir=terraform/app-edge destroy` never removes it — the SPA's URL keeps working across every teardown/spin-up cycle; only its API calls degrade gracefully (per `lib/api.ts`'s "backend not configured" / "backend unavailable" handling) while the edge is down. See [operations/cost-lifecycle.md](../../operations/cost-lifecycle.md).
- **The runtime-`config.json` seam turns the eventual HTTPS/domain swap into an infrastructure change, not a frontend rewrite.** When CloudFront + a stable domain land, the only frontend-relevant change is what `cd.yml` writes into `config.json` (and, if the domain becomes stable, that config could eventually be static) — no SPA source change is required, because the SPA never hardcodes an endpoint. This mirrors the same no-hardcoded-endpoint convention the backend services already follow ([`service-contract.md`](../../../.claude/rules/service-contract.md)).
- **`config.json` freshness is coordinated across two pipelines by convention, not by locking:** backend `cd.yml` writes it with `--cache-control no-cache` after every `app-edge` apply; `frontend-cd.yml` explicitly excludes it from its sync. If both workflows happened to run at the exact same moment, the two writes could theoretically race, but neither ever removes the other's object, so the worst case is a briefly stale URL, not data loss.
- **SPA deep-links return HTTP 404 (body still renders).** With `error_document = index.html`, S3 website hosting serves the app for any client-side route (e.g. a refresh on `/products`), but the HTTP **status is 404** — a known quirk of this pattern, not a bug. The page works; only status-code-based checks (uptime monitors, some crawlers) see the 404. A later CloudFront setup can rewrite this to a 200; until then it's an accepted cosmetic limitation.
- **CORS is a prerequisite for the first real API call (not yet needed).** The SPA (S3 website origin) calls the ALB on a *different* origin, so the first backend service the SPA calls **must return CORS headers** or the browser blocks the response even when the ALB is reachable. There is no backend service yet, so nothing to configure now — but this is captured as a binding requirement in [`service-contract.md`](../../../.claude/rules/service-contract.md) (application contract item 7) so it lands with the first `/new-service`.

## Alternatives considered

- **CloudFront + ACM + a custom domain now.** Rejected for this PRD — solves a problem (HTTPS) the API doesn't have a matching solution for yet (mixed content still blocks HTTP API calls from an HTTPS page), and is real, billable, multi-resource infrastructure better scoped as its own PRD than folded into the initial scaffold.
- **Build-time API URL (baked into the JS bundle via a Vite env var at build).** Rejected — the ALB's DNS name changes on every `app-edge` teardown/recreate ([ADR 0003](0003-base-edge-split.md)), so a build-time URL would require a full frontend rebuild+redeploy after every backend teardown cycle just to point at the new ALB, defeating the point of decoupling the two pipelines.
- **A small backend-for-frontend (BFF) service to proxy/inject the API URL server-side.** Rejected — it's another billable ECS service for a problem a static `config.json` object already solves for free.

## Related docs

- [ADR 0001 — Platform & Compute Architecture](0001-platform-and-compute-architecture.md) — the cost posture and private-by-default data posture this ADR carves a scoped exception into.
- [ADR 0003 — Base/Edge Split](0003-base-edge-split.md) — why `app-base` is permanent/free and `app-edge`'s ALB DNS churns, which is what makes the runtime-config seam necessary.
- [`service-contract.md`](../../../.claude/rules/service-contract.md) — the no-hardcoded-endpoint rule this decision extends to the frontend.
- [PRD frontend/0001](../../action_plan/frontend/0001-spa-scaffold-and-hosting.md) — the plan this ADR was extracted from.
- [operations/adding-a-frontend-feature.md](../../operations/adding-a-frontend-feature.md) — how a teammate adds a page against this model.
- [architecture/overview.md](../overview.md) — the Frontend section summarizing how this fits the rest of the system.
