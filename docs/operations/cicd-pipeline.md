# CI/CD Pipeline: Terraform Infrastructure

How the two GitHub Actions workflows check and apply changes to the `terraform/` root config, and the operational rules that follow from the keyless-auth model. Built by [PRD platform/0002](../action_plan/platform/0002-cicd-pipeline.md); decision context in [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md); the underlying OIDC/state-backend foundation is documented in [terraform-foundation.md](terraform-foundation.md) — read that first for the bootstrap pattern, the `soa-boundary` permissions-boundary pattern, and the deployer's self-edit denies, all of which apply here unchanged.

Workflow sources: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml). IAM sources: [`terraform/iam.tf`](../../terraform/iam.tf).

## 1. The two workflows

### `ci.yml` — Terraform fmt / validate / plan

- **Trigger:** `pull_request` targeting `main`. Runs on every PR, with **no path filter** — see §5 for why that matters (it's a required branch-protection check).
- **Auth:** assumes `soa-ci-plan` via OIDC (`vars.AWS_PLAN_ROLE_ARN`).
- **Steps:** `terraform fmt -check -recursive` (repo-wide), `terraform init` against the shared state bucket, `terraform validate`, `terraform plan -lock=false`.
- **Why `-lock=false`:** `soa-ci-plan` is read-only by design (see §2/`terraform/iam.tf:605-615`); acquiring a native S3 state lock requires a write to the state bucket, which the role should never need to do just to plan. `plan` itself writes no state, so skipping the lock is safe — it only becomes a problem if a concurrent `apply` is also mutating state at that exact moment, which `cd.yml`'s own lock still protects against.

### `cd.yml` — Terraform apply

- **Trigger:** `push` to `main`, filtered to `paths: terraform/**`.
- **Auth:** assumes `soa-deployer` via OIDC (`vars.AWS_DEPLOY_ROLE_ARN`).
- **Steps:** `terraform init` against the shared state bucket, `terraform apply -auto-approve`.
- **Why the path filter is safe here:** unlike `ci.yml`, `cd.yml` is not a required branch-protection check, so a push to `main` that doesn't touch `terraform/**` simply not triggering it is harmless — there's nothing to apply. See §5 for why the same filter would be unsafe on the CI side.

Both workflows declare `permissions: id-token: write` (needed to mint the OIDC token) and `contents: read` only — no other GitHub token scopes.

## 2. Keyless OIDC model (recap)

Full mechanics — the OIDC provider, the trust-policy pattern, the `soa-boundary` permissions ceiling — are in [terraform-foundation.md §4](terraform-foundation.md#4-the-keyless-auth-model). The short version, and what's new in this PRD:

- One GitHub OIDC provider (`aws_iam_openid_connect_provider.github_actions`) proves a token really came from GitHub Actions for this repo.
- **`soa-deployer`**'s trust condition matches only `sub = repo:<org>/<repo>:ref:refs/heads/main` — assumable only from a `main`-branch run. This is what `cd.yml` assumes.
- **`soa-ci-plan`** (new in this PRD) trusts only `sub = repo:<org>/<repo>:pull_request` — assumable only from a pull-request run, never from a `main`-branch push. This is what `ci.yml` assumes. It carries AWS-managed `ReadOnlyAccess` plus a `soa-ci-plan-data-read-deny` policy (`terraform/iam.tf:642-673`) that strips out the application-data reads (`dynamodb:GetItem`/`Query`/`Scan`/etc., `s3:GetObject` outside the state bucket) that `ReadOnlyAccess` grants but `terraform plan` never uses — narrowing what any PR run on this repo can read, even though PRs here are same-repo only today (open risk noted in PRD platform/0002 §9).
- Neither role ever shares the other's trust condition, so a PR run cannot assume `soa-deployer` and a `main`-branch push cannot assume `soa-ci-plan` — enforced at the IAM trust-policy level, independent of anything the workflow YAML does.

## 3. GitHub Actions variables

Four non-sensitive identifiers, stored as repo **variables** (not secrets — none of them grant access on their own; the OIDC trust policy is what restricts who can assume a role):

| Variable | Used by | Source |
| --- | --- | --- |
| `AWS_REGION` | both workflows | project's chosen region |
| `TF_STATE_BUCKET` | both workflows (`terraform init -backend-config=`) | `terraform output` in `terraform/bootstrap/` |
| `AWS_DEPLOY_ROLE_ARN` | `cd.yml` | `terraform output deployer_role_arn` |
| `AWS_PLAN_ROLE_ARN` | `ci.yml` | `terraform output ci_plan_role_arn` |

View or change them:

```bash
gh variable list
gh variable set <NAME> --body "<value>"
```

or via the GitHub UI under repo Settings → Secrets and variables → Actions → Variables. Never put these ARNs or the bucket name in a committed file — pull them fresh from `terraform output` when setting the variable.

## 4. Developer flow

1. Branch off `main`, make a change (typically under `terraform/`).
2. Open a pull request into `main` → `ci.yml` runs automatically as `soa-ci-plan`: fmt check, init, validate, plan.
3. **Branch protection on `main`** requires the PR and requires the `Terraform fmt / validate / plan` check to pass before the merge button is enabled — a red or pending CI run blocks merge; a direct `git push` to `main` is rejected outright.
4. Merge → `cd.yml` runs automatically as `soa-deployer` on the push to `main` (only if the diff touches `terraform/**`): init, `apply -auto-approve`.

There is no manual approval gate between merge and apply — auto-apply on `main` was a deliberate choice for this project (PRD platform/0002 §3, out of scope: "a production/staging environment split or manual approval gates"). Review happens at the PR stage, not post-merge.

## 5. Operational rules and gotchas

- **The deployer cannot modify its own IAM.** `soa-deployer`'s policy carries explicit self-edit denies (`DenyDeployerPolicySelfEdit`, `DenyDeployerRoleSelfEdit`) — see [terraform-foundation.md §5](terraform-foundation.md#5-operational-rule-the-deployer-cannot-touch-its-own-iam). This extends to `soa-ci-plan` and the boundary too: nothing in `soa-deployer`'s policy lets it create a role matching a human-managed identity outside its own `iam:CreateRole` grant's normal path, and any change to `soa-deployer`/`soa-ci-plan`/`soa-boundary` themselves must be applied by a **human running `terraform apply` with admin credentials** (§1 of terraform-foundation.md), never by `cd.yml`. This is exactly why the fix giving `soa-deployer` the read-only `iam:ListRolePolicies`/`iam:GetRolePolicy`/`iam:ListRoleTags` actions it needs to `terraform refresh` its own managed roles (`terraform/iam.tf:410-437`) had to be applied locally first, before the pipeline could run cleanly against the updated state.
- **Do not `terraform destroy` this config.** The OIDC provider, `soa-deployer`, `soa-ci-plan`, and `soa-boundary` in `terraform/` are a permanent, free foundation (all IAM — no billable resources), not part of the routine teardown cycle. Billable infrastructure (network, ECS, ALB, etc.) is planned to live in a separate `terraform/app/` config/state (PRD platform/0002 §9, review follow-up #1) so that `terraform destroy` between sessions only tears down that config and never touches these identities. If the identities are ever destroyed anyway, both workflows stop working immediately (nothing to assume) and a human must re-run the `terraform/` root apply with admin credentials to recreate them before CD can run again — `soa-deployer` cannot recreate itself or `soa-ci-plan` (the boundary and `policy/soa-*` conditions block it, by design).
- **Transient `AccessDenied` after an IAM change is expected.** Same IAM eventual-consistency behavior noted in [terraform-foundation.md §1](terraform-foundation.md#1-local-prerequisites): if a role or policy was just created/updated (by a human apply), the very next workflow run — or the next `aws`/`terraform` call — can fail with a transient `AccessDenied` before the change propagates account-wide. Re-run the job; this is not a real permissions problem.

## 6. Known follow-up: `soa-ci-plan` data-read deny

`soa-ci-plan` is read-only via AWS-managed `ReadOnlyAccess`, which is broader than `terraform plan` needs — it also grants item-level DynamoDB reads and S3 object-content reads. Before any service PRD introduces a real DynamoDB table or S3 bucket with actual data in it, this project already has the `soa-ci-plan-data-read-deny` policy in place (`terraform/iam.tf:642-673`) — an explicit Deny on `dynamodb:GetItem`/`BatchGetItem`/`Query`/`Scan`/`PartiQLSelect` and `s3:GetObject` (exempting the Terraform state bucket, so `plan` can still read remote state). It exists now, ahead of any data-bearing resource, so a pull-request run against this repo can never read application data content through the plan role — only the config/metadata (`Describe*`, `ListBucket`, etc.) that `plan` actually performs.

## 7. Teardown

Deleting the workflow files (`.github/workflows/ci.yml`, `cd.yml`) disables the pipeline; nothing about them bills. Removing `soa-ci-plan` (role, `ReadOnlyAccess` attachment, and the data-read-deny policy) follows the same path as the rest of the identities in §5 above — a human `terraform destroy`/edit against the `terraform/` root config, not something this pipeline does to itself, and not something to do routinely per §5.
