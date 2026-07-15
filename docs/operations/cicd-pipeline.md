# CI/CD Pipeline: Terraform Infrastructure

How the two GitHub Actions workflows check and apply changes to the app tier, and the operational rules that follow from the keyless-auth model. Built by [PRD platform/0002](../action_plan/platform/0002-cicd-pipeline.md); retargeted from the `terraform/` root to `terraform/app/` by [PRD platform/0003](../action_plan/platform/0003-network.md), per [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md); **`terraform/app/` was then split into `terraform/app-base/` + `terraform/app-edge/`** by [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md), per [ADR 0003](../architecture/decisions/0003-base-edge-split.md); decision context in [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md). The underlying OIDC/state-backend foundation is documented in [terraform-foundation.md](terraform-foundation.md) — read that first for the bootstrap pattern, the `soa-boundary` permissions-boundary pattern, and the deployer's self-edit denies, all of which apply here unchanged.

**The pipeline only ever applies the app tier — `app-base` and `app-edge`.** The identity foundation (`terraform/` root — OIDC provider, `soa-deployer`, `soa-ci-plan`, `soa-boundary`) and the state-bucket bootstrap (`terraform/bootstrap/`) are **human-applied**, never touched by `ci.yml`/`cd.yml` — see [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) and [terraform-foundation.md](terraform-foundation.md) for how to apply those by hand.

Workflow sources: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml). IAM sources: [`terraform/iam.tf`](../../terraform/iam.tf).

## 1. The two workflows

### `ci.yml` — Terraform fmt / validate / plan

- **Trigger:** `pull_request` targeting `main`. Runs on every PR, with **no path filter** — see §5 for why that matters (it's a required branch-protection check).
- **Auth:** assumes `soa-ci-plan` via OIDC (`vars.AWS_PLAN_ROLE_ARN`).
- **Working directory:** both `terraform/app-base/` and `terraform/app-edge/` — the job runs `init`/`validate`/`plan` against each in turn (`app-base` first, so `app-edge`'s plan can resolve `app-base`'s outputs via remote state). **The job name itself is unchanged** — still "Terraform fmt / validate / plan" — it just now covers two configs instead of one.
- **Steps:** `terraform fmt -check -recursive` (run against the repo root — stays **repo-wide**, so it still catches formatting drift anywhere under `terraform/`, including the shared `terraform/modules/` tree, not just one config), then `terraform init`/`validate`/`plan -lock=false` **for each config**, against the shared state bucket. `app-edge`'s plan reads `app-base`'s state via `terraform_remote_state` (`data.terraform_remote_state.base` in `app-edge/main.tf`) — this works read-only under `soa-ci-plan` the same way it works under `soa-deployer`, since it's just an `s3:GetObject` on the state bucket.
- **Why `-lock=false`:** `soa-ci-plan` is read-only by design (see §2/`terraform/iam.tf:692-708`, unaffected by the split); acquiring a native S3 state lock requires a write to the state bucket, which the role should never need to do just to plan. `plan` itself writes no state, so skipping the lock is safe — it only becomes a problem if a concurrent `apply` is also mutating state at that exact moment, which `cd.yml`'s own lock still protects against.

### `cd.yml` — Terraform apply

- **Trigger:** `push` to `main`, filtered to `paths: terraform/app-base/**`, `terraform/app-edge/**`, `terraform/modules/**`, and `services/**` (plus the `cd.yml` workflow file itself). Narrowed from a blanket `terraform/**` filter in [PRD platform/0003](../action_plan/platform/0003-network.md) — a push that only touches the human-applied `terraform/` root or `terraform/bootstrap/` no longer fires CD. `services/**` is included so an application-code change (a new commit SHA → new image → rolling deploy) also triggers a deploy.
- **Auth:** assumes `soa-deployer` via OIDC (`vars.AWS_DEPLOY_ROLE_ARN`).
- **Steps:** `terraform init` + `apply -auto-approve` against **`app-base`** first (network, cluster, execution role, ALB SG, any new service's table — usually a near-no-op), then (for each service under `services/*`, excluding `_template`) build + push its `soa-<name>` image, then `terraform init` + `apply -auto-approve` against **`app-edge`** (ALB, listener, every service's compute). See [compute-layer.md §4](compute-layer.md#4-pipeline-build-push-deploy) for the full per-service build/deploy sequence, including the ECR-repo-first-then-image-then-full-apply ordering within the `app-edge` half.
- **Why the path filter is safe here:** unlike `ci.yml`, `cd.yml` is not a required branch-protection check, so a push to `main` that doesn't touch the app tier simply not triggering it is harmless — there's nothing to apply. See §5 for why the same filter would be unsafe on the CI side.

Both workflows declare `permissions: id-token: write` (needed to mint the OIDC token) and `contents: read` only — no other GitHub token scopes.

## 2. Keyless OIDC model (recap)

Full mechanics — the OIDC provider, the trust-policy pattern, the `soa-boundary` permissions ceiling — are in [terraform-foundation.md §4](terraform-foundation.md#4-the-keyless-auth-model). The short version, and what's new in this PRD:

- One GitHub OIDC provider (`aws_iam_openid_connect_provider.github_actions`) proves a token really came from GitHub Actions for this repo.
- **`soa-deployer`**'s trust condition matches only `sub = repo:<org>/<repo>:ref:refs/heads/main` — assumable only from a `main`-branch run. This is what `cd.yml` assumes.
- **`soa-ci-plan`** (new in this PRD) trusts only `sub = repo:<org>/<repo>:pull_request` — assumable only from a pull-request run, never from a `main`-branch push. This is what `ci.yml` assumes. It carries AWS-managed `ReadOnlyAccess` plus a `soa-ci-plan-data-read-deny` policy (`terraform/iam.tf:735-761`) that strips out the application-data reads (`dynamodb:GetItem`/`Query`/`Scan`/etc., `s3:GetObject` outside the state bucket) that `ReadOnlyAccess` grants but `terraform plan` never uses — narrowing what any PR run on this repo can read, even though PRs here are same-repo only today (open risk noted in PRD platform/0002 §9).
- Neither role ever shares the other's trust condition, so a PR run cannot assume `soa-deployer` and a `main`-branch push cannot assume `soa-ci-plan` — enforced at the IAM trust-policy level, independent of anything the workflow YAML does.

## 3. GitHub Actions variables

Four non-sensitive identifiers, stored as repo **variables** (not secrets — none of them grant access on their own; the OIDC trust policy is what restricts who can assume a role):

| Variable | Used by | Source |
| --- | --- | --- |
| `AWS_REGION` | both workflows | project's chosen region |
| `TF_STATE_BUCKET` | both workflows (`terraform init -backend-config=`) for **both** configs; also needed as `app-edge`'s `state_bucket` input (`TF_VAR_state_bucket=$TF_STATE_BUCKET`) so its `terraform_remote_state` read of `app-base` resolves — see [`terraform/app-edge/variables.tf`](../../terraform/app-edge/variables.tf) | `terraform output` in `terraform/bootstrap/` |
| `AWS_DEPLOY_ROLE_ARN` | `cd.yml` | `terraform output deployer_role_arn` |
| `AWS_PLAN_ROLE_ARN` | `ci.yml` | `terraform output ci_plan_role_arn` |

No new variable was added by the base/edge split — the same `TF_STATE_BUCKET` value already covers both configs' state keys (`app-base/terraform.tfstate`, `app-edge/terraform.tfstate`) since they share one bucket; it just now also needs to be exposed as `TF_VAR_state_bucket` for the `app-edge` job step.

View or change them:

```bash
gh variable list
gh variable set <NAME> --body "<value>"
```

or via the GitHub UI under repo Settings → Secrets and variables → Actions → Variables. Never put these ARNs or the bucket name in a committed file — pull them fresh from `terraform output` when setting the variable.

## 4. Developer flow

1. Branch off `main`, make a change (typically under `terraform/app-base/`, `terraform/app-edge/`, or the shared `terraform/modules/`).
2. Open a pull request into `main` → `ci.yml` runs automatically as `soa-ci-plan`: repo-wide fmt check, then init/validate/plan against **both** `app-base` and `app-edge`.
3. **Branch protection on `main`** requires the PR and requires the `Terraform fmt / validate / plan` check to pass before the merge button is enabled — a red or pending CI run blocks merge; a direct `git push` to `main` is rejected outright. The check name is unchanged even though it now covers two configs.
4. Merge → `cd.yml` runs automatically as `soa-deployer` on the push to `main` (only if the diff touches the app tier or the `cd.yml` file itself): init + `apply -auto-approve` against **`app-base`**, then against **`app-edge`** — see §1.

Changes to the identity foundation (`terraform/` root) or the state-bucket bootstrap (`terraform/bootstrap/`) follow a different, human-applied path — see [terraform-foundation.md](terraform-foundation.md) §3 — and never trigger `cd.yml`.

There is no manual approval gate between merge and apply — auto-apply on `main` was a deliberate choice for this project (PRD platform/0002 §3, out of scope: "a production/staging environment split or manual approval gates"). Review happens at the PR stage, not post-merge.

## 5. Operational rules and gotchas

- **The deployer cannot modify its own IAM.** `soa-deployer`'s policy carries explicit self-edit denies (`DenyDeployerPolicySelfEdit`, `DenyDeployerRoleSelfEdit`) — see [terraform-foundation.md §5](terraform-foundation.md#5-operational-rule-the-deployer-cannot-touch-its-own-iam). This extends to `soa-ci-plan` and the boundary too: nothing in `soa-deployer`'s policy lets it create a role matching a human-managed identity outside its own `iam:CreateRole` grant's normal path, and any change to `soa-deployer`/`soa-ci-plan`/`soa-boundary` themselves must be applied by a **human running `terraform apply` with admin credentials** (§1 of terraform-foundation.md), never by `cd.yml`. This is exactly why the fix giving `soa-deployer` the read-only `iam:ListRolePolicies`/`iam:GetRolePolicy`/`iam:ListRoleTags` actions it needs to `terraform refresh` its own managed roles (`terraform/iam.tf:469-486`) had to be applied locally first, before the pipeline could run cleanly against the updated state.
- **Do not `terraform destroy` the `terraform/` root config, or `terraform/app-base/`.** The OIDC provider, `soa-deployer`, `soa-ci-plan`, and `soa-boundary` in `terraform/` (root) are a permanent, free foundation (all IAM — no billable resources), not part of the routine teardown cycle, and not something either workflow ever applies (see [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md)). As of [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md), **`terraform/app-base/` is the same kind of permanent, do-not-destroy config** — network, cluster, execution role, ALB SG, and every service's DynamoDB table (see [ADR 0003](../architecture/decisions/0003-base-edge-split.md)). Only **`terraform/app-edge/`** (ALB + per-service compute) is what routine `terraform destroy` between sessions targets. If the identities or `app-base` are ever destroyed anyway: the identities require a human `terraform apply` with admin credentials to recreate (`soa-deployer` cannot recreate itself or `soa-ci-plan` — the boundary and `policy/soa-*` conditions block it, by design); `app-base` can be recreated by the pipeline (it's pipeline-applied), but every table's **data is gone** — table re-creation is not data recovery.
- **The deployer's DynamoDB access is control-plane only — it can create/update `soa-*` tables but can never delete one or touch its rows.** Added by PRD platform/0006 for self-serve tables and tightened after infra-review: the `DynamoDbTableLifecycleManagement` Allow is the *only* DynamoDB grant on `soa-deployer` (the previous broad `dynamodb:*`/`*` statement was removed), scoped to `soa-*` tables in-region and limited to the exact control-plane actions Terraform's `aws_dynamodb_table` needs — **no data-plane** (`DeleteItem`/`PutItem`/etc.) and **no `DeleteTable`**. The `DenyDynamoDbTableDeletion` Deny remains as a backstop. So an `app-base` apply that would destroy-and-recreate a table fails with `AccessDenied` rather than dropping data, and the pipeline has no way to delete rows either — see [ADR 0003](../architecture/decisions/0003-base-edge-split.md) and [cost-lifecycle.md](cost-lifecycle.md). (In the same tightening, the deployer's Terraform state access was narrowed to the `app-base/`+`app-edge/` keys, so it can't read or delete the human-applied `platform/` identity state.)
- **Transient `AccessDenied` after an IAM change is expected.** Same IAM eventual-consistency behavior noted in [terraform-foundation.md §1](terraform-foundation.md#1-local-prerequisites): if a role or policy was just created/updated (by a human apply), the very next workflow run — or the next `aws`/`terraform` call — can fail with a transient `AccessDenied` before the change propagates account-wide. Re-run the job; this is not a real permissions problem.

## 6. Known follow-up: `soa-ci-plan` data-read deny

`soa-ci-plan` is read-only via AWS-managed `ReadOnlyAccess`, which is broader than `terraform plan` needs — it also grants item-level DynamoDB reads and S3 object-content reads. Before any service PRD introduces a real DynamoDB table or S3 bucket with actual data in it, this project already has the `soa-ci-plan-data-read-deny` policy in place (`terraform/iam.tf:735-761`) — an explicit Deny on `dynamodb:GetItem`/`BatchGetItem`/`Query`/`Scan`/`PartiQLSelect` and `s3:GetObject` (exempting the Terraform state bucket, so `plan` can still read remote state). It exists now, ahead of any data-bearing resource, so a pull-request run against this repo can never read application data content through the plan role — only the config/metadata (`Describe*`, `ListBucket`, etc.) that `plan` actually performs. Unaffected by the base/edge split: `soa-ci-plan` never gained the table-lifecycle grant PRD platform/0006 gave `soa-deployer` — it stays fully read-only.

## 7. Teardown

Deleting the workflow files (`.github/workflows/ci.yml`, `cd.yml`) disables the pipeline; nothing about them bills. Removing `soa-ci-plan` (role, `ReadOnlyAccess` attachment, and the data-read-deny policy) follows the same path as the rest of the identities in §5 above — a human `terraform destroy`/edit against the `terraform/` root config, not something this pipeline does to itself, and not something to do routinely per §5. **Routine, cost-driven teardown is not this** — it's `terraform -chdir=terraform/app-edge destroy`, which never touches the pipeline's own identities or `app-base`; see [cost-lifecycle.md](cost-lifecycle.md).

## Related docs

- [terraform-foundation.md](terraform-foundation.md) — the OIDC/state-backend foundation and `soa-boundary` pattern this pipeline builds on.
- [compute-layer.md](compute-layer.md) — what the pipeline actually builds/deploys each run, and the base-then-edge apply sequence in detail.
- [adding-a-service.md](adding-a-service.md) — how a new service's two Terraform blocks flow through this pipeline.
- [cost-lifecycle.md](cost-lifecycle.md) — the teardown/spin-up procedure this pipeline supports.
- [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) / [ADR 0003](../architecture/decisions/0003-base-edge-split.md) — why the app tier is split the way it is.
- [PRD platform/0002](../action_plan/platform/0002-cicd-pipeline.md) / [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) — the plans and outcomes behind this pipeline's shape.
