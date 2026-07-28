# 0005 — Cognito Auth, SPA-Direct, Over HTTP (Narrows ADR 0004)

> Use Amazon Cognito as the application's identity provider, called **SPA-direct** over its public HTTPS APIs (`SignUp`/`ConfirmSignUp`/`InitiateAuth` via SRP) from a custom login UI, with a **public** app client (no secret) and no hosted UI — pool and client provisioned in `app-base`, identifiers delivered to the SPA through the existing runtime `config.json` seam, without waiting for the deferred HTTPS/CloudFront PRD.

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

[ADR 0004](0004-frontend-hosting.md) deferred "real Cognito auth" alongside HTTPS, on the grounds that "Amazon Cognito requires HTTPS redirect URIs for its hosted UI — it cannot be wired against an HTTP-only site." That statement is correct, but it is narrower than it reads: **the HTTPS redirect-URI requirement belongs to the Cognito *hosted UI*** (`callback_urls`, `allowed_oauth_flows`, a Cognito domain) — not to Cognito itself. Cognito's `SignUp`, `ConfirmSignUp`, and `InitiateAuth` APIs are called directly over HTTPS, the same way any third-party HTTPS API is called from a page served over HTTP. That is not "mixed content" — the browser's mixed-content block stops an **HTTPS** page from loading **HTTP** subresources; it says nothing about an HTTP page making HTTPS calls, which is the direction here.

[PRD platform/0009](../../action_plan/platform/0009-cognito-user-pool.md) exists because the rubric's User Service authentication requirement was being met by a client-supplied user id — a service stub trusts whatever caller identity the frontend sends, not a real identity provider. Waiting for the full HTTPS/CloudFront PRD ([ADR 0004](0004-frontend-hosting.md), "Alternatives considered") to unblock auth would tie a small, freely available identity feature to unbuilt, billable, multi-resource infrastructure (CloudFront + ACM + a custom domain) with its own coherent scope. The `/grill-me` session behind platform/0009 established that the hosted-UI constraint does not actually block the API-driven flow, so auth does not need to wait.

## Decision

**Application authentication is Amazon Cognito, used SPA-direct over its public HTTPS APIs, with a custom login UI and no hosted UI.**

- One `aws_cognito_user_pool` (email sign-in, `CONFIRM_WITH_CODE` email verification) and one **public** `aws_cognito_user_pool_client` (`generate_secret = false`) live in `terraform/modules/cognito/`, wired into `app-base` — permanent and free (Cognito is free up to 50,000 MAU), so accounts survive every `app-edge` teardown, exactly like service tables ([ADR 0003](0003-base-edge-split.md)).
- The SPA calls Cognito's `SignUp` / `ConfirmSignUp` / `InitiateAuth` (SRP) APIs directly from a hand-built login/registration UI — no Cognito hosted UI, no Cognito domain, no `callback_urls`. Because there is no hosted UI, there are no redirect URIs, and the HTTPS-redirect-URI constraint ADR 0004 cited simply does not apply to this flow.
- The app client is **public** (no secret) — the only correct shape for code that runs in a browser — and only `ALLOW_USER_SRP_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` are enabled; `ALLOW_USER_PASSWORD_AUTH` is deliberately not, so a password never crosses the wire in any form.
- Services verify the caller's identity by validating the Cognito **ID token against the pool's public JWKS** — no shared secret, no `AdminInitiateAuth`/`GetUser` call back to Cognito, no IAM in the request path. This keeps verification stateless and keeps Cognito out of every service's runtime IAM footprint.
- The pool id and client id are **non-secret** (a public client has no secret to leak) and are published to the SPA the same way the API base URL already is: two new `app-base` outputs, written into `s3://<frontend-bucket>/config.json` by `cd.yml`, read at startup by the SPA's existing runtime-config seam ([ADR 0004](0004-frontend-hosting.md)). No new delivery mechanism is introduced.

This ADR **narrows, not supersedes,** [ADR 0004](0004-frontend-hosting.md): the hosting model (S3 static website over plain HTTP), the runtime `config.json` seam, and the HTTPS/CloudFront deferral all stand unchanged. Only the auth-deferral paragraph is corrected — it over-scoped a hosted-UI constraint to all of Cognito.

## Consequences

- **The page delivering the login UI is still tamperable in transit.** The SPA continues to be served over plain HTTP ([ADR 0004](0004-frontend-hosting.md)); anyone able to intercept that HTTP response could modify the JavaScript — including the login form — before it runs. This is a real, honest limitation, not solved by this decision, and it is exactly what the deferred HTTPS/CloudFront PRD retires.
- **ID tokens travel to the ALB over HTTP** once issued, and are therefore interceptable on a hostile network in transit to the backend. Mitigated, not solved, by a short **1-hour** access/ID token lifetime (refresh tokens last 30 days but only ever go to Cognito, over HTTPS).
- **Passwords never cross the wire in any form.** SRP (`ALLOW_USER_SRP_AUTH`) is a zero-knowledge proof protocol — the password itself is never transmitted, to Cognito or otherwise, regardless of the transport HTTPS/HTTP question above.
- **This trade is accepted for a disposable course environment with no real user data**, and is strictly better than the status quo it replaces (an always-signed-in mock user with no identity provider at all). It is explicitly temporary, retired the moment the HTTPS/CloudFront PRD lands and the SPA itself moves to HTTPS.
- **`deletion_protection = "ACTIVE"` on the pool** makes deleting it — and every account in it — a deliberate human action, mirroring the `DeleteTable` deny that protects service tables ([ADR 0003](0003-base-edge-split.md)).
- **No IAM widening was needed.** `soa-deployer` already held `cognito-idp:*`; provisioning the pool and client required no root-identity apply, no change to `terraform/` root, and no change to the `soa-boundary`.
- **Services gain a new, but self-contained, verification dependency**: validating a JWT against the pool's JWKS at request time. This adds no new AWS IAM call and no shared secret — the JWKS is fetched over public HTTPS and is itself non-secret.

## Alternatives considered

- **Cognito hosted UI, after the HTTPS/CloudFront PRD lands.** The textbook Cognito integration, but it blocks the User Service's auth deliverable on infrastructure (CloudFront + ACM + a custom domain) that is unbuilt, billable, and scoped as its own coherent PRD ([ADR 0004](0004-frontend-hosting.md), "Alternatives considered"). Rejected for this PRD specifically because the hosted-UI constraint that justified the wait does not actually apply to the API-driven flow.
- **Service-proxied auth (`AdminInitiateAuth` behind the API, no SPA-direct Cognito calls).** Rejected: `soa-boundary` permits `AdminInitiateAuth` but not `SignUp`/`AdminCreateUser`, so registration would require widening the boundary — an admin-credentialed apply against the human-applied root identity config ([`iam.tf`](../../../terraform/iam.tf)) — for a feature SPA-direct registration needs no IAM at all to deliver.
- **A hand-rolled JWT issued by the user service.** Rejected: it means hand-rolled authentication crypto (a real security liability compared to a managed identity provider), and a signing secret that would need to live in SSM — which means a new `ssm:PutParameter` grant for `soa-deployer`, another root-identity apply, and a secret sitting in Terraform state. Cognito's JWKS-based verification needs none of that.

## Related docs

- [ADR 0001 — Platform & Compute Architecture](0001-platform-and-compute-architecture.md) — the cost posture (free-tier-first) this decision extends into identity.
- [ADR 0003 — Base/Edge Split](0003-base-edge-split.md) — why the pool lives in `app-base` and survives every `app-edge` teardown, and the `DeleteTable`-deny pattern this ADR's `deletion_protection` mirrors.
- [ADR 0004 — Frontend Hosting](0004-frontend-hosting.md) — the ADR this narrows: hosting model and HTTPS deferral stand; only the auth-deferral reasoning is corrected.
- [PRD platform/0009 — Cognito User Pool](../../action_plan/platform/0009-cognito-user-pool.md) — the plan this ADR was extracted from, including the full pool/client configuration table and the `/grill-me` decisions behind it.
- [PRD user/0001 — User Service](../../action_plan/user/0001-user-service.md) — the consumer of this PRD's outputs (registration/login UI, token verification in the service).
- [`service-contract.md`](../../../.claude/rules/service-contract.md) — the no-hardcoded-endpoint rule this decision's `config.json` delivery follows.
