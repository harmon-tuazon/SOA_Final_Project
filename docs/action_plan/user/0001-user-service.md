# 0001 — User Service (Cognito-authenticated profile & billing)

> Scaffold `services/user/` — a Cognito-authenticated REST API owning user **profile** and **billing information** in its own DynamoDB table — and replace the SPA's auth stub with a real register → confirm → login flow.

## 1. Status & metadata

- **Status:** In Progress <!-- Draft → Approved → In Progress → Done (or Abandoned) -->
- **Date:** 2026-07-23
- **Approved:** 2026-07-24 by the repo owner ("start executing them all in the correct order")
- **Author:** Jean-Luc (with Claude Code)

> Execution may only start once the user has confirmed **Approved**. The design below was settled via `/grill-me` on 2026-07-23.

**Amendment (2026-07-24, at the repo owner's direction):** all work in this PRD — including the two Terraform blocks specified in §5.1 — is executed **in this repo** by the planned agents, superseding the DevOps-handoff pattern described in the ownership note below. §5.1 stands as the specification being implemented, not a handoff. Manual out-of-band steps are tracked under [`docs/to-dos/`](../../to-dos/README.md).

**Depends on [`platform/0009`](../platform/0009-cognito-user-pool.md)** — the Cognito user pool, its app client, and the `config.json` plumbing that carries their ids to the SPA. This PRD's app code can be written and unit-tested before that lands, but **cannot be verified end-to-end until it does**.

**Ownership note:** per the amendment in [`order/0001` §3](../order/0001-service-scaffold.md), **infrastructure is owned by the DevOps team**. The two Terraform blocks this service needs are therefore *specified* in §5.1 and handed off, not written here — the same pattern `order/0001` used. **Consequence: until DevOps lands them, `services/user/` is buildable, testable and runnable locally, but is not deployed, has no `soa-user` table, and is not reachable on the ALB.**

## 2. User story

As a **shopper using the storefront**, I want to **register with my email, confirm it, sign in, and manage my profile and billing details**, so that **the application knows who I am** instead of treating every visitor as the same hardcoded mock user.

As the **project team**, we want **the User Service the rubric names** — registration, authentication and profiles — built so that **identity is owned by a managed provider (Cognito) while the service owns only the data it is responsible for**, demonstrating a clean service boundary rather than a hand-rolled auth system.

## 3. Scope

**In scope:**

- `services/user/` scaffolded from [`services/_template/`](../../../services/_template/), satisfying the [service contract](../../../.claude/rules/service-contract.md) in full.
- **Cognito ID-token verification** on every protected route, against the pool's public **JWKS** (via `aws-jwt-verify`) — no shared secret, no SSM parameter, no outbound IAM call.
- The profile + billing REST API in §3.2, over the entity in §3.1, backed by the service's own DynamoDB table.
- **Rejection of raw card data** — any request carrying a PAN or CVV is refused with `400` before it can reach the database or the logs (§3.3).
- **CORS** for the S3-hosted SPA origin, read from `CORS_ALLOWED_ORIGIN` (contract §7).
- Unit + integration tests: `/health` with no AWS and no token; token verification (valid / expired / wrong-audience / missing) with a mocked verifier; profile and billing round-trips against **DynamoDB Local**; the PAN/CVV rejection cases.
- A `docker-compose.yml` block for local dev against the existing `dynamodb-local` container.
- **Frontend auth wiring** — replacing the stub in [`frontend/src/auth/AuthContext.tsx`](../../../frontend/src/auth/AuthContext.tsx) with real Cognito session state, adding register / confirm-code / login screens, making [`ProtectedRoute`](../../../frontend/src/auth/ProtectedRoute.tsx) actually gate, attaching the `Authorization` header in [`lib/api.ts`](../../../frontend/src/lib/api.ts), and adding profile + billing pages under `frontend/src/features/users/`.
- Docs: the service README, this PRD's Outcome, and the index line.

**Out of scope:**

- **All Terraform** — handed to DevOps as the spec in §5.1 (see the ownership note in §1).
- **The Cognito pool itself** — [`platform/0009`](../platform/0009-cognito-user-pool.md).
- **Any async path.** No `UserRegistered` event, no welcome email. `functions/` does not exist and the deployer holds no `lambda:*` grant. Follow-up: the reserved `platform/0008` messaging factory, then `user/0002`.
- **Cross-service token enforcement.** Order service and everything else stay untouched and unauthenticated; `customerId` remains an opaque string there. Settled during `/grill-me` to keep this deliverable independent of teammates' code. Consequence in §9.2.
- **Password reset, password change, MFA, social login, account deletion.** Cognito supports them; each is a screen and a flow, and none is needed to satisfy the rubric. Later PRD.
- **Admin surfaces** — listing users, disabling accounts, role/group management.
- **Real payment processing.** `paymentMethodToken` is an opaque stand-in for a PSP token; no PSP is integrated and no charge is ever made.
- **Storing card numbers or CVVs — permanently out of scope**, not deferred (§3.3).
- Pagination, search, avatars/file upload, email change.
- Any `terraform apply` / `aws` / `docker push` run by hand — the pipeline owns deployment.

### 3.1 Entity — `user` profile

Partition key `userId` (string) = the Cognito **`sub`** claim. Cognito is the source of truth for credentials, email and verification status; this table holds only what Cognito does not.

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | string | **hash key**; the Cognito `sub` from the verified token — never taken from the request body |
| `email` | string | copied from the verified token's `email` claim on upsert; **read-only** via this API (Cognito owns it) |
| `displayName` | string | user-editable, ≤ 100 chars |
| `phone` | string | user-editable, optional, ≤ 30 chars |
| `createdAt` | string | server-set ISO-8601 on first upsert |
| `updatedAt` | string | server-set ISO-8601 on every write |
| `billing` | object | absent until first set; shape below |

`billing` sub-object:

| Field | Type | Notes |
| --- | --- | --- |
| `cardholderName` | string | required |
| `cardBrand` | string | one of `VISA`, `MASTERCARD`, `AMEX`, `DISCOVER` |
| `cardLast4` | string | exactly 4 digits |
| `cardExpMonth` | integer | 1–12 |
| `cardExpYear` | integer | current year … +20 |
| `paymentMethodToken` | string | opaque stand-in for a PSP token |
| `billingAddress` | object | `line1`, `city`, `postalCode`, `country` — all required |

### 3.2 Routes (all under the `/users*` ALB route)

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health` | none | 200, plain text, **DB-free** — ALB target-group check |
| `GET` | `/users/me` | Bearer | Returns the caller's profile, **lazily creating** the row from token claims on first call → `200` |
| `PUT` | `/users/me` | Bearer | Updates `displayName` / `phone` only → `200`; `400` on invalid body |
| `GET` | `/users/me/billing` | Bearer | Returns the billing sub-object → `200`, or `404` if never set |
| `PUT` | `/users/me/billing` | Bearer | Sets/replaces billing → `200`; `400` on invalid body **or on any PAN/CVV present** (§3.3) |
| `DELETE` | `/users/me/billing` | Bearer | Removes the billing sub-object → `204` |
| `OPTIONS` | `/users*` | none | CORS preflight → `204` |

Every protected route resolves the user **only** from the verified token — there is no `/users/:id`, so one user can never address another's record. Missing/invalid/expired token → `401`.

### 3.3 The PAN/CVV guard (binding)

`PUT /users/me/billing` rejects with `400` — before any write and before any logging — if the body contains a key matching `/^(card)?(number|pan|cvv|cvc|securitycode)$/i`, **or** any string value consisting of 13–19 digits (ignoring spaces and dashes). Request bodies on billing routes are never logged. This is what makes "billing information" safe to demo, and it is a deliberate talking point for the presentation, not an accident.

### 3.4 Auth flow

```
SPA ──(1) SignUp(email, password)──────────────► Cognito      [HTTPS, no IAM]
    ◄─(2) 6-digit code by email────────────────
SPA ──(3) ConfirmSignUp(email, code)───────────► Cognito
SPA ──(4) InitiateAuth(SRP)────────────────────► Cognito
    ◄─(5) ID token + refresh token─────────────
SPA ──(6) GET /users/me  Authorization: Bearer <id token>──► ALB ──► user service
                                                                     │
                                              (7) verify signature against pool JWKS
                                                  (public keys, cached, no IAM)
                                                                     │
                                              (8) upsert + read row keyed by sub
                                                                     ▼
                                                                 DynamoDB
```

The service never holds a Cognito credential and never calls a Cognito API — step 7 is signature verification against public keys.

## 4. Success criteria

Each is checkable by a command in §8.

1. `npm test` in `services/user/` passes, covering: `/health` 200 with no AWS creds **and no token**; a request with no/invalid/expired token → `401`; a token minted for a different audience → `401`; profile lazy-create on first `GET /users/me`; `PUT /users/me` ignoring any attempt to set `userId`/`email`; billing round-trip; `DELETE` → `204` then `GET` → `404`.
2. Every PAN/CVV rejection case in §3.3 returns `400` and writes nothing to the table.
3. `docker build services/user/` succeeds and the image runs as **non-root** (`docker run --rm --entrypoint id soa-user:test` reports a non-zero uid).
4. `grep -rInE "elb\.amazonaws\.com" services/user` returns **no matches** — the CI gate at [`ci.yml:34-38`](../../../.github/workflows/ci.yml#L34-L38) passes.
5. No secret, pool id, client id or origin is hardcoded: `services/user/src` reads all of them from `process.env`.
6. `npm run build` in `frontend/` succeeds and `npm test` (if defined) passes; the SPA boots with an **unconfigured** `config.json` without crashing (graceful "auth not configured" state).
7. **After the DevOps handoff (§5.1) lands:** `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` pass, and `plan` shows creates with **0 destroys**.
8. **After the handoff lands:** listener priority **110** is unique in `app-edge`, and the `user` task role carries **`soa-boundary`** scoped to `soa-user` (+ `/index/*`) only — no `*` resource, no inline policy, no AWS-managed policy.
9. **After merge + CD:** `curl -s -o /dev/null -w '%{http_code}' http://<alb-dns>/users/me` returns **401** (proving the route is live *and* enforcing auth), and returns **200** with a valid ID token.
10. A full deployed round-trip: register in the SPA → code arrives → confirm → sign in → profile page loads → save billing → reload shows it persisted.
11. `docs/action_plan/README.md` gains a `user/` group with this PRD listed.

## 5. Resources

**AWS resources created** (all via existing shared modules — no new module is written by this PRD):

| Resource | Terraform type | Config | Cost |
| --- | --- | --- | --- |
| `soa-user` DynamoDB table | `aws_dynamodb_table` (via `modules/data`) | `app-base` | **Free tier** — PAY_PER_REQUEST, 25 GB free; demo traffic ≈ $0. Permanent |
| `soa-user` ECR repo | `aws_ecr_repository` (via `modules/ecs-service`) | `app-edge` | **Free tier** — 500 MB/mo private storage |
| `soa-user` ECS service + task definition | `aws_ecs_service`, `aws_ecs_task_definition` | `app-edge` | **Billable** — 1 Fargate task @ 256 CPU / 512 MiB ≈ **$0.012/hr ≈ $9/mo while up**. Dies on `app-edge` teardown |
| `soa-user` target group + listener rule | `aws_lb_target_group`, `aws_lb_listener_rule` | `app-edge` | **Free** — attaches to the existing shared ALB |
| `soa-user` task role + `soa-user-*` policy | `aws_iam_role`, `aws_iam_policy` | `app-edge` | **Free** |
| `soa-user` task security group | `aws_security_group` | `app-edge` | **Free** |
| `/ecs/soa-user` log group | `aws_cloudwatch_log_group` | `app-edge` | **Free tier** — 5 GB/mo |
| Autoscaling target + policy | `aws_appautoscaling_*` | `app-edge` | **Free** (scaling out adds task cost) |

**Net new cost:** ~**$9/mo of Fargate while `app-edge` is up**, on top of the existing ALB and order service. Returns to **$0** on the routine teardown ([cost-lifecycle.md](../../operations/cost-lifecycle.md)). Nothing permanent and billable is added — the Cognito pool itself is free ([`platform/0009`](../platform/0009-cognito-user-pool.md)).

**Repo files touched:**

- **New:** `services/user/` (`src/app.js`, `src/index.js`, `src/users.js`, `src/auth.js`, `Dockerfile`, `package.json`, `.dockerignore`, `README.md`, `tests/`); `frontend/src/features/users/` (`ProfilePage.tsx`, `BillingPage.tsx`, `api.ts`); `frontend/src/auth/` register/confirm/login screens.
- **Edited:** [`frontend/src/auth/AuthContext.tsx`](../../../frontend/src/auth/AuthContext.tsx), [`frontend/src/auth/ProtectedRoute.tsx`](../../../frontend/src/auth/ProtectedRoute.tsx), [`frontend/src/lib/config.ts`](../../../frontend/src/lib/config.ts) (+2 keys), [`frontend/src/lib/api.ts`](../../../frontend/src/lib/api.ts) (Bearer header), `frontend/src/router.tsx`, `frontend/src/Layout.tsx` (sign-in/out affordance), [`docker-compose.yml`](../../../docker-compose.yml), [`docs/action_plan/README.md`](../README.md).
- **Edited by the DevOps handoff, not here:** `terraform/app-base/main.tf`, `terraform/app-edge/main.tf`.
- **Not touched:** `services/_template/`, `services/order/`, `terraform/modules/*`, `terraform/` root identity config, the workflows.

**New dependencies:** `aws-jwt-verify` (service — AWS-maintained, zero-dependency JWKS verification) and `amazon-cognito-identity-js` (frontend — the browser SDK for `SignUp`/`ConfirmSignUp`/SRP `InitiateAuth`).

**Derived infrastructure** (from the [service contract](../../../.claude/rules/service-contract.md), no decision needed):

| | |
| --- | --- |
| Service folder | `services/user/` |
| AWS names | `soa-user` |
| Table | `soa-user`, hash key `userId` |
| Env | `USER_TABLE`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `CORS_ALLOWED_ORIGIN`, `PORT=3000` |
| ALB route | `/users*` |
| Listener priority | **110** (order holds 100; the next service takes 120) |
| Port | 3000 |

### 5.1 DevOps handoff — the two Terraform blocks this service needs

Not written by this PRD. Shapes copied from the canonical seams already in each config; recipe context: [adding-a-service.md](../../operations/adding-a-service.md).

**a) The table — append to [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf):**

```hcl
# user service (PRD user/0001). Permanent: profile + billing data survives
# every app-edge teardown, and the pipeline is denied DeleteTable. The hash
# key is the Cognito `sub` — Cognito owns identity, this table owns profile.
module "user_table" {
  source = "../modules/data"

  name_prefix = var.name_prefix
  name        = "user"
  hash_key    = "userId"
}
```

**b) The service — append to [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf):**

```hcl
module "user_service" {
  source = "../modules/ecs-service"

  name_prefix = var.name_prefix
  region      = var.region
  name        = "user"
  port        = 3000
  image_tag   = var.image_tag
  route       = "/users*"
  priority    = 110

  env = {
    USER_TABLE            = "${var.name_prefix}-user"
    COGNITO_USER_POOL_ID  = local.cognito_user_pool_id
    COGNITO_CLIENT_ID     = local.cognito_client_id
  }

  table_arns         = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-user"]
  vpc_id             = local.vpc_id
  public_subnet_ids  = local.public_subnet_ids
  cluster_id         = local.cluster_id
  alb_sg_id          = local.alb_sg_id
  listener_arn       = module.alb.listener_arn
  execution_role_arn = local.execution_role_arn
  boundary_arn       = local.boundary_arn
}
```

Notes for whoever applies this:

- **`local.cognito_user_pool_id` / `local.cognito_client_id` do not exist yet.** They are added alongside the existing `local.*` aliases in `app-edge/main.tf`, reading [`platform/0009`](../platform/0009-cognito-user-pool.md)'s new `app-base` outputs through the same `terraform_remote_state` data source the other foundation values already use. **This block will not plan until `platform/0009` has been applied.**
- **Both values are non-secret** (a pool id and a *public* app client id) — injecting them as plain `env` is correct and does not violate the no-secrets-in-task-definitions rule. The service needs no secret at all, because it verifies tokens against public JWKS.
- **`CORS_ALLOWED_ORIGIN` should be set** to the `frontend` module's website endpoint output. Unlike `order`, this is not optional in practice: the SPA sends an `Authorization` header, which makes every call a **preflighted** cross-origin request, so a missing/incorrect origin breaks the app even though the ALB is reachable.
- **Priority 110 is free** — `order_service` holds 100.
- **No task-role change is needed for Cognito.** JWKS verification is an unauthenticated HTTPS fetch of public keys; the boundary's `cognito-idp:*` allowances are not used by this design.
- Both configs are pipeline-applied — no manual `terraform apply` once merged.

**External references:** [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify), [verifying a Cognito JWT](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html), [`amazon-cognito-identity-js`](https://www.npmjs.com/package/amazon-cognito-identity-js), [`@aws-sdk/lib-dynamodb`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-dynamodb/).

## 6. Scripts / commands

Run locally by the agents — **nothing billable, nothing that touches AWS state**:

```bash
# 1. Scaffold + implement (app-engineer)
cp -r services/_template services/user       # then replace the three tokens
cd services/user && npm install
npm install aws-jwt-verify
npm test

# 2. Local integration against DynamoDB Local
docker compose up -d dynamodb-local
docker compose up --build user
curl -s localhost:3000/health                 # 200, no token
curl -s -o /dev/null -w '%{http_code}' localhost:3000/users/me   # 401
docker compose down

# 3. Image check
docker build -t soa-user:test services/user
docker run --rm --entrypoint id soa-user:test  # must NOT be uid=0

# 4. No hardcoded endpoints (same rule CI enforces)
grep -rInE "elb\.amazonaws\.com" services/user   # must return nothing

# 5. Frontend (app-engineer)
cd frontend && npm install amazon-cognito-identity-js && npm run build

# 6. After the DevOps handoff lands — validate/plan ONLY, never apply
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge validate
terraform -chdir=terraform/app-edge plan       # expect creates, 0 destroys
```

**Post-merge verification only** (read-only against the deployed environment):

```bash
ALB=$(terraform -chdir=terraform/app-edge output -raw alb_dns_name)
curl -s -o /dev/null -w '%{http_code}' "http://$ALB/users/me"                 # 401
curl -s -H "Authorization: Bearer $ID_TOKEN" "http://$ALB/users/me"           # 200
```

**No `terraform apply`, no `terraform destroy`, no `aws ecs update-service`, no `docker push` is authorized by this PRD** — CD owns all of them.

## 7. Planned agents

| Step | Agent | Hands off |
| --- | --- | --- |
| This PRD | **main session** (per [action-plan rule](../../../.claude/rules/action-plan.md)) | The app spec (§3) and the DevOps spec (§5.1) |
| `services/user/` — routes, token verification, DynamoDB access, PAN guard, tests, Dockerfile, `docker-compose.yml` block | **app-engineer** | A green `npm test`, a non-root image, a clean endpoint grep |
| Frontend auth wiring + profile/billing pages | **app-engineer**, following [adding-a-frontend-feature.md](../../operations/adding-a-frontend-feature.md) | A green `npm run build` and a SPA that degrades gracefully when `config.json` lacks the Cognito keys |
| The two Terraform blocks | **DevOps team** *(or `terraform-engineer` if the ownership note in §1 is reversed)* | `validate` + `plan` showing creates, 0 destroys |
| Review before merge | **infra-reviewer** | Findings on the boundary/table scoping, priority uniqueness, cost, and that no secret or endpoint is hardcoded |
| Service README, ADR cross-links, index line | **documentation-keeper** | Docs consistent with [`.claude/rules/documentation.md`](../../../.claude/rules/documentation.md) |

## 8. Testing / verification plan

| Criterion (§4) | How it is verified |
| --- | --- |
| 1 | `npm test` in `services/user/` — jest + supertest; the token cases use a locally-minted key pair with a mocked JWKS endpoint, so tests need **no AWS and no network** |
| 2 | Dedicated jest cases posting each forbidden shape (`cardNumber`, `pan`, `cvv`, `cvc`, a bare 16-digit string, a spaced/dashed 16-digit string) → assert `400` **and** assert the DynamoDB Local item is unchanged |
| 3 | `docker build` then `docker run --rm --entrypoint id soa-user:test` |
| 4, 5 | The grep in §6 step 4; plus manual read-through that `src/` contains no literal pool id, client id, origin or table name |
| 6 | `npm run build` in `frontend/`; plus loading the SPA against a `config.json` with the Cognito keys removed and confirming it renders an "auth not configured" state rather than a blank page |
| 7, 8 | `terraform validate` + `plan` after the handoff; the plan's task-role policy and listener priority read by **infra-reviewer** |
| 9 | The two `curl`s in §6 against the deployed ALB — the `401` matters as much as the `200`, since it proves enforcement rather than an open endpoint |
| 10 | Manual end-to-end pass in a browser with a real inbox, recorded for the final presentation |
| 11 | The index line exists |

**Infra-reviewer pass is mandatory before merge.** Specifically: the task role is boundary-carrying and `soa-user`-scoped, priority 110 collides with nothing, no new billable resource beyond the one Fargate task, and no credential or endpoint is embedded anywhere.

## 9. Additional considerations

### 9.1 Security posture

- **The service holds no credential.** Token verification uses the pool's public JWKS; there is no shared secret, no SSM parameter, and no IAM call. This is why the design needed no change to the deployer or the boundary — worth stating in the presentation, since it is the strongest security property of the whole approach.
- **Tokens travel over plain HTTP** between the SPA and the ALB, and the SPA itself is served over HTTP ([ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)). An interceptor on a hostile network could replay an ID token for up to its 1-hour lifetime. **Accepted, documented limitation** of a disposable course environment with no real data — retired by the deferred HTTPS/CloudFront PRD. See [`platform/0009` §9.1](../platform/0009-cognito-user-pool.md).
- **`amazon-cognito-identity-js` persists tokens in `localStorage` by default**, which means an XSS bug would expose them. Acceptable here (the SPA has no user-generated content to inject through), but it should be a conscious choice recorded in the frontend README, not a default nobody noticed.
- **No card data ever enters the system** (§3.3), so a table leak exposes an address, a name, a brand and four digits — deliberately not a payment-credential breach.
- **Authorization is by token subject only.** There is no `/users/:id`, so horizontal privilege escalation is structurally impossible rather than prevented by a check that could be forgotten.

### 9.2 Known gap this PRD deliberately leaves open

Order service remains **unauthenticated** and still trusts a client-supplied `customerId` — so a signed-in user's identity is *not* yet enforced on their orders. That was the settled `/grill-me` decision (keep this deliverable independent of teammates' code), and it is now cheap to close: with Cognito in place, any service can verify the same tokens against the same public JWKS with no shared secret. Recommended follow-up: `order/0002`, or a small cross-cutting PRD once more than one service needs it.

### 9.3 Rollback / teardown path

- The **table lives in `app-base`** — profile and billing data survives every `terraform -chdir=terraform/app-edge destroy`, and the pipeline is denied `DeleteTable`, so no CD run can drop it ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)).
- The **ECS service, ECR repo, target group, listener rule, task role, SG and log group all die with `app-edge`** and come back on the next apply. Fargate spend returns to $0.
- Rolling back a bad deploy is redeploying the previous SHA-tagged task definition — the standard path, no service-specific work.
- Reverting the whole feature means reverting the PR; the SPA falls back to its stub auth, and the Cognito pool sits unused at $0.

### 9.4 Dependencies, sequencing and timing

1. [`platform/0009`](../platform/0009-cognito-user-pool.md) must be **approved, merged and applied** before this service can be verified end-to-end (criteria §4.9–§4.10). App code and unit tests (§4.1–§4.6) do not wait on it.
2. The DevOps handoff (§5.1) must land before anything deploys — and its `local.cognito_*` aliases depend on step 1.
3. **A real inbox is needed** for the confirmation code. Pre-create a demo account before the presentation rather than depending on live email delivery in front of an audience.
4. Cognito's built-in email sender is capped at ~50/day and can land in spam — fine for a demo, noted so nobody debugs a "broken" signup that is really a spam filter.

### 9.5 Rubric mapping

Satisfies "**User Service:** Handles user registration, authentication, and profiles" from [PROJECT REQUIREMENTS.md](../../../PROJECT%20REQUIREMENTS.md); contributes to the least-privilege IAM task role, per-service database, CORS-correct service interaction, unit/integration testing, and CI/CD criteria. It does **not** contribute to the async SQS/Lambda criterion — that remains the reserved `platform/0008` factory's job.

---

## Outcome

_Filled after execution: what actually happened, deviations from plan. Set status to Done._
