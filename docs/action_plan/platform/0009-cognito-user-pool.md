# 0009 — Cognito User Pool (SPA-direct auth over HTTP)

> Provision an Amazon Cognito user pool + public app client in `app-base`, and publish its non-secret identifiers to the SPA through the existing runtime `config.json` seam — unblocking real authentication **without** waiting for the deferred HTTPS/CloudFront PRD.

## 1. Status & metadata

- **Status:** In Progress <!-- Draft → Approved → In Progress → Done (or Abandoned) -->
- **Date:** 2026-07-23
- **Approved:** 2026-07-24 by the repo owner ("start executing them all in the correct order")
- **Author:** Jean-Luc (with Claude Code)

> Execution may only start once the user has confirmed **Approved**. Decisions below were settled via `/grill-me` on 2026-07-23 — they are recorded, not assumed.

**Amendment (2026-07-24, at the repo owner's direction):** all work in this PRD — including the Terraform module/wiring and the `cd.yml` change specified in §5.1 — is executed **in this repo** by the planned agents, superseding the DevOps-handoff pattern described in the ownership note below. §5.1 stands as the specification being implemented, not a handoff. Manual out-of-band steps are tracked under [`docs/to-dos/`](../../to-dos/README.md).

**Numbering note:** this PRD takes **0009**, not 0008. [`order/0001`](../order/0001-service-scaffold.md) already forward-references `platform/0008` as the async messaging factory (SQS/SNS/Lambda); that number is left reserved so the existing cross-link stays valid.

**Ownership note:** per the amendment in [`order/0001` §3](../order/0001-service-scaffold.md), **infrastructure is owned by the DevOps team**. This PRD therefore *specifies* the Terraform and pipeline change (§5.1) and hands it off verbatim rather than writing it. If that convention has changed and this repo's author now owns Terraform directly, only §3, §6 and §7 need adjusting — the specification in §5.1 is the same either way.

## 2. User story

As the **project team**, we want **a real identity provider backing the application**, so that **services stop trusting a client-supplied user id** and the "authentication" line the rubric asks of the User Service is actually met.

As the **developer of the user service**, I want **the pool's identifiers delivered to the SPA the same way the API URL already is**, so that **nothing hardcodes an environment-specific value** and the frontend keeps working across every `app-edge` teardown cycle.

## 3. Scope

**In scope:**

- A new shared module `terraform/modules/cognito/` — one `aws_cognito_user_pool` and one **public** `aws_cognito_user_pool_client` (no client secret), configured for **email sign-in with an emailed confirmation code** (§3.1).
- Wiring that module into [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) — the **permanent, free** half of the split ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)), so user accounts survive every `app-edge` teardown.
- Two new `app-base` outputs (`cognito_user_pool_id`, `cognito_client_id`) — consumed by CD, and by `app-edge` via the existing `terraform_remote_state` read.
- Extending CD's `config.json` step ([`cd.yml:161-169`](../../../.github/workflows/cd.yml#L161-L169)) to publish those two identifiers alongside `apiBaseUrl`.
- **ADR 0005**, recording that Cognito is viable over plain HTTP via the API flow, and explicitly narrowing [ADR 0004's](../../architecture/decisions/0004-frontend-hosting.md) auth-deferral paragraph.

**Out of scope:**

- **The Cognito hosted UI**, and therefore any `callback_urls` / `allowed_oauth_flows` / domain configuration. The hosted UI is what genuinely requires HTTPS redirect URIs; the `SignUp` / `ConfirmSignUp` / `InitiateAuth` APIs this design uses do not. See §9.1.
- **HTTPS, CloudFront, ACM, a custom domain.** Still deferred to their own coherent PRD, exactly as [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md) planned. This PRD deliberately does **not** pre-empt it.
- **The user service itself** — `services/user/`, its table, its routes and the SPA screens are [`user/0001`](../user/0001-user-service.md), which depends on this PRD.
- **Lambda triggers** of any kind (pre-signup auto-confirm, post-confirmation hooks). `functions/` does not exist and the deployer holds no `lambda:*` grant — dragging that in is the reserved `platform/0008` factory, not this.
- **A Cognito identity pool.** No browser-side AWS credentials are needed; the SPA only ever holds JWTs and calls the ALB.
- **MFA, social/federated identity providers, user groups, admin user-management endpoints, custom email via SES.** All future work; the built-in Cognito email sender is sufficient (§9.3).
- **Service-proxied auth** (`AdminInitiateAuth` behind the API). Rejected during `/grill-me`: the `soa-boundary` permits `AdminInitiateAuth` but **not** `SignUp`/`AdminCreateUser` ([`iam.tf:188-197`](../../../terraform/iam.tf#L188-L197)), so registration would require widening the boundary via an admin-credentialed apply on the root identity config. SPA-direct registration needs no IAM at all.

### 3.1 Pool configuration (the decisions this PRD encodes)

| Setting | Value | Why |
| --- | --- | --- |
| Sign-in identifier | `username_attributes = ["email"]` | Users sign in with email; Cognito enforces uniqueness, so the service needs no email index of its own. |
| Verification | `auto_verified_attributes = ["email"]`, `CONFIRM_WITH_CODE` | Emailed 6-digit code, confirmed via `ConfirmSignUp`. Free, no Lambda, and demonstrates a genuine multi-step auth flow. |
| App client secret | **none** (`generate_secret = false`) | A browser SPA cannot hold a secret. A public client is the correct and required shape here. |
| Auth flows | `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH` | SRP never puts the password on the wire. `ALLOW_USER_PASSWORD_AUTH` is deliberately **not** enabled. |
| Token lifetimes | ID/access **1 hour**, refresh **30 days** | Cognito defaults; short access windows limit the blast radius of a token leaked over HTTP (§9.1). |
| `prevent_user_existence_errors` | `ENABLED` | Stops the login endpoint from confirming whether an email is registered. |
| `deletion_protection` | `ACTIVE` | `soa-deployer` holds `cognito-idp:*` ([`iam.tf:477-483`](../../../terraform/iam.tf#L477-L483)); this makes destroying the pool — and every account in it — a deliberate human act, mirroring the `DeleteTable` denial that protects service tables. |

## 4. Success criteria

Each is checkable by a command in §8.

1. `terraform -chdir=terraform/app-base fmt -check` and `validate` both pass.
2. `terraform -chdir=terraform/app-base plan` shows the pool, the client and nothing else as **creates — 0 destroys, 0 replacements**. No existing table, bucket, VPC or cluster is touched.
3. The planned app client has **no secret** (`generate_secret = false`) and its `explicit_auth_flows` contain `ALLOW_USER_SRP_AUTH` but **not** `ALLOW_USER_PASSWORD_AUTH`.
4. The planned pool has `deletion_protection = "ACTIVE"` and `auto_verified_attributes = ["email"]`.
5. **No change is required to `terraform/` root** — `git diff --stat terraform/*.tf` is empty for this work. (The deployer already holds `cognito-idp:*`; this is the property that makes the whole approach cheap.)
6. After CD runs, `curl -s http://<frontend-bucket-website-endpoint>/config.json` returns JSON containing non-empty `apiBaseUrl`, `cognitoUserPoolId` and `cognitoClientId`.
7. A real signup round-trip succeeds against the deployed pool: `aws cognito-idp sign-up` → a confirmation code arrives by email → `aws cognito-idp confirm-sign-up` → `initiate-auth` (SRP or admin flow) returns an ID token.
8. `docs/architecture/decisions/0005-cognito-auth-over-http.md` exists, is linked from [`docs/architecture/decisions/README.md`](../../architecture/decisions/README.md), and states which part of ADR 0004 it narrows.
9. `docs/action_plan/README.md` lists this PRD under `platform/`.

## 5. Resources

**AWS resources created:**

| Resource | Terraform type | Config | Cost |
| --- | --- | --- | --- |
| `soa-users` user pool | `aws_cognito_user_pool` | `app-base` | **Free tier — permanently free up to 50,000 monthly active users.** A course demo is a rounding error. Permanent (survives `app-edge` teardown). |
| `soa-spa` app client | `aws_cognito_user_pool_client` | `app-base` | **Free** — a configuration object, not a billable resource. |
| Confirmation emails | (built-in Cognito sender) | — | **Free**, capped at ~50/day (§9.3). |

**Net new cost: $0.** Nothing here is billable, and nothing here is destroyed by the routine `app-edge` teardown ([cost-lifecycle.md](../../operations/cost-lifecycle.md)).

**Repo files touched:**

- **New:** `terraform/modules/cognito/{main.tf,variables.tf,outputs.tf}`, `docs/architecture/decisions/0005-cognito-auth-over-http.md`.
- **Edited:** [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) (+ `module "cognito"`), [`terraform/app-base/outputs.tf`](../../../terraform/app-base/outputs.tf) (+ 2 outputs), [`.github/workflows/cd.yml`](../../../.github/workflows/cd.yml) (`config.json` step), [`docs/architecture/decisions/README.md`](../../architecture/decisions/README.md), [`docs/architecture/overview.md`](../../architecture/overview.md), [`docs/README.md`](../../README.md), [`docs/action_plan/README.md`](../README.md).
- **Not touched:** `terraform/` root identity config, `terraform/bootstrap/`, `terraform/app-edge/`, `terraform/modules/{data,ecs-service,alb,network,ecs-cluster,frontend}/`, `services/`.

### 5.1 DevOps handoff — the exact changes

**a) New module — `terraform/modules/cognito/main.tf`:**

```hcl
# cognito module: the application's identity provider. One user pool + one
# PUBLIC app client (no secret) for the browser SPA, which calls Cognito's
# SignUp / ConfirmSignUp / InitiateAuth APIs directly over HTTPS. No hosted
# UI, so no domain and no callback URLs — that is what would have required
# HTTPS redirect URIs (see ADR 0005).

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # Sign in with email; Cognito owns email uniqueness, so no service needs
  # its own email index.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your verification code"
    email_message        = "Your verification code is {####}"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false
  }

  # soa-deployer holds cognito-idp:* — this makes deleting the pool (and
  # every account in it) a deliberate human action, mirroring the
  # DeleteTable denial that protects service tables.
  deletion_protection = "ACTIVE"

  tags = {
    Name = "${var.name_prefix}-users"
  }
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  # A browser client cannot keep a secret. Public client is required.
  generate_secret = false

  # SRP only — the password never goes on the wire. USER_PASSWORD_AUTH is
  # deliberately absent.
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Don't leak whether an email is registered.
  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
```

`variables.tf` takes a single `name_prefix` (string). `outputs.tf` exposes `user_pool_id` (`aws_cognito_user_pool.this.id`), `user_pool_arn` (`.arn`) and `client_id` (`aws_cognito_user_pool_client.spa.id`).

**b) Wire into `terraform/app-base/main.tf`** (alongside `module "frontend"`, before the service tables):

```hcl
# Application identity provider (PRD platform/0009). Permanent and free:
# user accounts must survive every app-edge teardown, and the pool costs
# nothing below 50k MAU.
module "cognito" {
  source = "../modules/cognito"

  name_prefix = var.name_prefix
}
```

**c) Add to `terraform/app-base/outputs.tf`:**

```hcl
output "cognito_user_pool_id" {
  description = "ID of the application Cognito user pool. Non-secret — published to the SPA in config.json by cd.yml, and read by app-edge via terraform_remote_state for the user service's env."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "ID of the public SPA app client (no secret). Non-secret — published to the SPA in config.json by cd.yml."
  value       = module.cognito.client_id
}
```

**d) Extend the `config.json` step in [`.github/workflows/cd.yml`](../../../.github/workflows/cd.yml#L161-L169):**

```yaml
      - name: Refresh frontend config.json with current API URL
        run: |
          set -euo pipefail
          ALB=$(terraform -chdir=terraform/app-edge output -raw alb_dns_name)
          BUCKET=$(terraform -chdir=terraform/app-base output -raw frontend_bucket_name)
          POOL=$(terraform -chdir=terraform/app-base output -raw cognito_user_pool_id)
          CLIENT=$(terraform -chdir=terraform/app-base output -raw cognito_client_id)
          cat > config.json <<EOF
          {"apiBaseUrl":"http://$ALB","cognitoUserPoolId":"$POOL","cognitoClientId":"$CLIENT"}
          EOF
          aws s3 cp config.json "s3://$BUCKET/config.json" \
            --content-type application/json \
            --cache-control no-cache
```

Notes for whoever applies this:

- **Both identifiers are non-secret by design.** A Cognito user pool id and a *public* app client id are meant to be embedded in browser code — they are not credentials, and the client has no secret to leak. Publishing them in `config.json` (a public object in a public-read bucket, per [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)) is correct, not a posture regression.
- **The SPA needs no separate `region` key** — `amazon-cognito-identity-js` derives the region from the user pool id's prefix.
- **`app-base` is applied before `app-edge`** in CD, and the `config.json` step runs after both, so the outputs always exist by the time they are read.
- **No root-identity apply is needed.** `soa-deployer` already holds `cognito-idp:*`; if a plan nevertheless fails `AccessDenied`, stop and treat it as a finding rather than widening the boundary.

**External references:** [Cognito user pool authentication flow](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow.html), [`aws_cognito_user_pool_client` registry page](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_user_pool_client), [Cognito quotas & pricing](https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html).

## 6. Scripts / commands

Read-only locally — **this PRD runs nothing billable and applies nothing**. `app-base` is applied by CD on merge.

```bash
# 1. Terraform (terraform-engineer) — validate/plan ONLY, never apply
terraform -chdir=terraform/app-base fmt -check
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-base plan     # expect: 2 creates, 0 destroys

# 2. Confirm the root identity config was NOT touched
git diff --stat terraform/*.tf               # must be empty

# 3. After merge + CD (verification only)
curl -s "http://$(terraform -chdir=terraform/app-base output -raw frontend_website_endpoint)/config.json"

# 4. Smoke-test the pool end to end (creates one throwaway user; free)
POOL=$(terraform -chdir=terraform/app-base output -raw cognito_user_pool_id)
CLIENT=$(terraform -chdir=terraform/app-base output -raw cognito_client_id)
aws cognito-idp sign-up --client-id "$CLIENT" \
  --username <a-real-inbox@example.com> --password '<TempPassw0rd>'
# ...code arrives by email...
aws cognito-idp confirm-sign-up --client-id "$CLIENT" \
  --username <a-real-inbox@example.com> --confirmation-code <code>
```

The only AWS-mutating command listed is `sign-up`/`confirm-sign-up`, which creates one free test account. **No `terraform apply`, no `terraform destroy`, no resource deletion is authorized by this PRD.**

## 7. Planned agents

| Step | Agent | Hands off |
| --- | --- | --- |
| This PRD | **main session** (per [action-plan rule](../../../.claude/rules/action-plan.md)) | The spec in §5.1 |
| `terraform/modules/cognito/` + `app-base` wiring + outputs | **terraform-engineer** *(or the DevOps team — see the ownership note in §1)* | A clean `fmt`/`validate`/`plan` showing 2 creates, 0 destroys |
| `cd.yml` `config.json` step | **pipeline-engineer** | The extended step, with the two new outputs read from `app-base` |
| ADR 0005 + `overview.md` / index updates | **documentation-keeper** | The ADR, cross-linked both ways with ADR 0004 |
| Review before merge | **infra-reviewer** | Findings on cost, the public-client shape, deletion protection, and that no root-identity change crept in |

## 8. Testing / verification plan

| Criterion (§4) | How it is verified |
| --- | --- |
| 1 | `terraform -chdir=terraform/app-base fmt -check && terraform -chdir=terraform/app-base validate` |
| 2 | `terraform -chdir=terraform/app-base plan` — read the summary line; must be `2 to add, 0 to change, 0 to destroy` |
| 3, 4 | Read the plan output for the client's `generate_secret`/`explicit_auth_flows` and the pool's `deletion_protection`/`auto_verified_attributes`; confirmed independently by **infra-reviewer** |
| 5 | `git diff --stat terraform/*.tf` is empty; CI's `terraform plan` job succeeds as `soa-ci-plan` without new permissions |
| 6 | `curl` the deployed `config.json` (§6 step 3) and assert all three keys are present and non-empty |
| 7 | The `sign-up` → email code → `confirm-sign-up` → `initiate-auth` round-trip in §6 step 4 returns an `IdToken` |
| 8, 9 | The files exist and the index/ADR-README lines are present; checked in review |

**Infra-reviewer pass is mandatory before merge**, specifically confirming: the app client has no secret, `USER_PASSWORD_AUTH` is absent, the pool sits in `app-base` (not `app-edge`), and nothing billable was introduced.

## 9. Additional considerations

### 9.1 Security posture — the honest limitation

The SPA is served over **plain HTTP** ([ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)), and that does not change here. What this design does and does not give you:

- **Credentials are not exposed in transit.** The login form posts to Cognito over **HTTPS**, and SRP means the password itself never crosses the wire in any form. An HTTP page making an HTTPS request is not "mixed content" — that restriction applies only to an HTTPS page loading HTTP subresources.
- **But the page delivering that form is tamperable.** Anyone able to intercept the HTTP response from S3 could modify the JavaScript before it runs. **This is a real, documented limitation**, not something to gloss over in the presentation — and it is exactly what the deferred HTTPS/CloudFront PRD retires.
- **ID tokens travel to the API over HTTP** and are therefore interceptable on a hostile network. Mitigated, not solved, by the 1-hour token lifetime.

This is an acceptable trade for a **disposable course environment with no real user data** — and it is strictly better than the status quo (an always-signed-in mock user). It must be stated plainly in ADR 0005 rather than buried.

### 9.2 Rollback / teardown path

- The pool lives in **`app-base`**, so the routine `terraform -chdir=terraform/app-edge destroy` **does not touch it** — accounts survive every cost-saving teardown, exactly like service tables ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)).
- Rolling this back before it ships is reverting the PR. Rolling it back *after* means deleting the pool, which `deletion_protection = "ACTIVE"` deliberately blocks until a human clears the flag — **deleting the pool destroys every account irreversibly**.
- If the whole approach proves wrong, the SPA falls back to the stub `AuthContext` with a one-file revert; the pool can sit unused at $0.

### 9.3 Open questions / dependencies

- **Cognito's built-in email sender is capped at ~50 messages/day** per pool and sends from a generic AWS address (which can land in spam). Fine for a demo and for a grader creating one account; if the team needs volume, that is an SES integration in a later PRD.
- **A real inbox is needed to sign up.** Worth pre-creating one demo account before the presentation rather than relying on live email delivery during it.
- **Dependency direction:** [`user/0001`](../user/0001-user-service.md) consumes this PRD's outputs. This one can ship and be verified entirely on its own; the reverse is not true.
- **Reserved:** `platform/0008` remains held for the async SQS/SNS/Lambda factory referenced by [`order/0001`](../order/0001-service-scaffold.md).

---

## Outcome

_Filled after execution: what actually happened, deviations from plan. Set status to Done._
