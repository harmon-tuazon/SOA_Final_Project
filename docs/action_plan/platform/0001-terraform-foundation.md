# 0001 — Terraform Foundation

> Stand up the Terraform foundation: a remote state backend (S3 with native locking), AWS provider config, GitHub OIDC provider, and a least-privilege deployer IAM role — the plumbing every later PRD builds on.

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-11
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-11 (user)
- **Completed:** 2026-07-11

> Decisions below were settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

### Amendment — 2026-07-11 (post-review, user-confirmed)

The `infra-reviewer` pass on the written code found one blocker and two warnings; the fixes below were confirmed with the user and add to the scope above:

1. **IAM permissions boundary (blocker fix).** The deployer's `CreateRole` + `AttachRolePolicy`/`PassRole` grant allowed it to mint a `soa-*` role with admin permissions and pass it to a task — a self-escalation path. Fix: add a `soa-boundary` managed policy (the effective-permission ceiling for all workload roles), require it as a `PermissionsBoundary` condition on every `iam:CreateRole`, deny the deployer from altering that boundary policy or stripping boundaries, restrict `iam:AttachRolePolicy` to `policy/soa-*` only, and drop the inline-role-policy actions.
2. **Partial backend config (warning fix).** The account ID moves out of `backend.tf` into a gitignored `backend.hcl` (with a committed `backend.hcl.example`); `init` uses `-backend-config=backend.hcl`.
3. **State bucket accidental-delete guard (warning fix).** Per user choice, use explicit `force_destroy = false` (deletable on purpose — empty the bucket / flip the flag — but a careless `terraform destroy` errors out) rather than a hard `prevent_destroy` lock.

**Follow-up finding (second review round):** the boundary fix initially left a *self*-escalation path — the deployer's own role/policy match the `soa-*` scope, so it could rewrite its own permissions or trust. Fixed with explicit `Deny` statements on the deployer's own role and policy ARNs (`DenyDeployerPolicySelfEdit`, `DenyDeployerRoleSelfEdit`) plus a corrected boundary-tampering deny split. **Operational consequence:** the pipeline can no longer alter the deployer's own IAM — changes to the deployer role/policy now require a human `terraform apply` with admin credentials.

## 2. User story

As the developer of this project, I want a reproducible Terraform foundation — remote state and keyless pipeline auth — so that every later piece of infrastructure is built the same way, safely, and can be torn down and rebuilt without losing track of what exists.

## 3. Scope

**In scope:**
- **Local prerequisite:** install Terraform **≥ 1.10** locally (documented step; not a resource). Version 1.10+ is required for S3-native state locking.
- **`terraform/bootstrap/`** — a one-time config (its own **local** state) that creates:
  - a **versioned S3 bucket** for remote state (`soa-tfstate-<account_id>`).
- **`terraform/` root config:**
  - `backend.tf` — S3 backend pointing at the bootstrap bucket, with **native locking** (`use_lockfile = true`) — no DynamoDB.
  - `provider.tf` / `versions.tf` — Terraform ≥ 1.10 + AWS provider pinned, region `us-east-1`, default resource tags.
  - `variables.tf` / `outputs.tf` — `region`, `name_prefix` (default `soa`), and outputs (OIDC provider ARN, deployer role ARN).
- **`terraform/modules/iam/`** (or root for now):
  - **GitHub OIDC identity provider** (`token.actions.githubusercontent.com`).
  - **Deployer IAM role** — trust scoped to `repo:harmon-tuazon/SOA_Final_Project:ref:refs/heads/main`; a **scoped custom permissions policy** seeded with the services from ADR 0001 (ECS, ECR, EC2/VPC, ELB, DynamoDB, SQS, SNS, CloudWatch Logs, Application Auto Scaling, Cognito, scoped IAM for task roles, and S3 state access).
- **`terraform/.gitignore`** — ignore `.terraform/`, `*.tfstate*`, `*.tfvars`.
- A short **operations doc** recording the backend + OIDC setup (written by `documentation-keeper` after execution).

**Out of scope (later PRDs):**
- Any real workload infra — VPC/subnets, ECS cluster/services, ECR repos, Lambda, DynamoDB app tables, ALB, SQS/SNS resources.
- The GitHub Actions workflow files (`ci.yml`/`cd.yml`) and a read-only CI **plan** role — these come with the pipeline PRD.
- Any application code under `services/` or `functions/`.

## 4. Success criteria

1. `terraform fmt -check` and `terraform validate` pass in both `terraform/bootstrap/` and `terraform/`.
2. Bootstrap apply creates the S3 bucket with versioning enabled — confirmed by `aws s3api get-bucket-versioning`.
3. `terraform init` on the root config succeeds using the S3 backend (state stored remotely, native S3 locking via `use_lockfile`).
4. `terraform plan` on the root config succeeds and shows the OIDC provider + deployer role as the resources to create (0 destroys).
5. After apply, `aws iam get-role` shows the deployer role's trust policy restricted to the repo's `main` branch, and the OIDC provider exists.
6. The deployer role's policy contains **no** `AdministratorAccess`, `PowerUserAccess`, or wildcard `Action:"*"`/`Resource:"*"` beyond narrowly justified cases — confirmed by the `infra-reviewer`.

## 5. Resources

| Resource | Terraform type | Cost impact |
| --- | --- | --- |
| State bucket | `aws_s3_bucket` (+ versioning, public-access-block) | Pennies (free-tier 5 GB) |
| GitHub OIDC provider | `aws_iam_openid_connect_provider` | Free |
| Deployer role + policy | `aws_iam_role`, `aws_iam_role_policy` | Free |

State locking uses a lock file inside the same S3 bucket (`use_lockfile = true`) — no separate lock resource.

**Total cost impact: ~$0.** No compute, no NAT, no ALB in this PRD. Nothing here is torn down by the normal `terraform destroy` cycle — the state backend is intentionally permanent.

External references: Terraform AWS provider registry (s3, iam_openid_connect_provider, iam_role); Terraform S3 backend `use_lockfile` docs; GitHub OIDC subject-claim docs.

## 6. Scripts / commands

Run by the **main session** on the user's machine (their configured AWS CLI), after approval, with the user observing. Billable/creating commands are marked ⚠️.

```bash
# 0. Prerequisite (one-time)
#    Install Terraform locally (e.g. via the HashiCorp installer / winget), then:
terraform version

# 1. Bootstrap the state backend (local state)
cd terraform/bootstrap
terraform init
terraform fmt -check && terraform validate
terraform plan
terraform apply            # ⚠️ creates the S3 state bucket (versioned)

# 2. Root config — adopt the remote backend
cd ../
terraform init             # initializes the S3 backend created in step 1
terraform fmt -check && terraform validate
terraform plan
terraform apply            # ⚠️ creates the GitHub OIDC provider + deployer IAM role

# 3. Verify
aws s3api get-bucket-versioning --bucket soa-tfstate-<account_id>
aws iam get-role --role-name soa-deployer --query 'Role.AssumeRolePolicyDocument'
```

## 7. Planned agents

- **`terraform-engineer`** — authors `terraform/bootstrap/`, the root config (`backend.tf`, provider, variables, outputs), and the IAM module (OIDC provider + deployer role + scoped policy). Runs `fmt`/`validate`/`plan`. Hands off validated code (does **not** apply — plan-only).
- **`infra-reviewer`** — reviews the code and plan output against cost/security/convention guardrails (esp. success criterion #6) before any apply. Hands off a go/no-go verdict.
- **Main session** — runs the `terraform apply` / verification commands (§6) after the reviewer's go and user approval, since applies are billable/creating and the terraform-engineer never applies.
- **`documentation-keeper`** — after execution, writes the `docs/operations/` note on the state backend + OIDC setup and updates the docs indexes.

## 8. Testing / verification plan

| Success criterion | Verification |
| --- | --- |
| #1 fmt/validate | `terraform fmt -check` + `terraform validate` in both configs (terraform-engineer) |
| #2 backend created | `aws s3api get-bucket-versioning` (§6 step 3) |
| #3 remote backend works | `terraform init` on root succeeds; state object appears in the bucket |
| #4 plan clean | `terraform plan` shows OIDC + role to add, 0 destroys |
| #5 trust + provider | `aws iam get-role` trust policy shows `...:ref:refs/heads/main`; OIDC provider listed |
| #6 least privilege | `infra-reviewer` pass on the policy — no Admin/PowerUser/wildcards |

## 9. Additional considerations

- **Security posture:** keyless pipeline auth (no long-lived AWS keys ever), deploy limited to `main`, deployer policy scoped and reviewer-gated. Sets the least-privilege baseline for the whole project.
- **Rollback/teardown:** the OIDC provider + deployer role can be removed with `terraform destroy` on the root config if needed. The **state backend is deliberately permanent** and excluded from routine teardown (destroying it would orphan all state). Removing it is a manual, last-step action after grading.
- **Beginner note:** step 1's bootstrap uses *local* state (a `terraform.tfstate` file on disk, gitignored). That's expected and fine — it only creates the two backend resources and is applied once.
- **Open items:**
  - The **CI plan role** (read-only, for `terraform plan` on PRs) is deferred to the pipeline PRD; until then, plans run locally or under the deployer role on `main`.
  - The **rubric "Kubernetes" wording** risk from [ADR 0001](../../architecture/decisions/0001-platform-and-compute-architecture.md) remains open — unrelated to this PRD but tracked.
- **Deviations** that change scope/cost/security require amending this PRD and re-confirming before continuing.

---

## Outcome

Executed 2026-07-11, all success criteria met.

- **Bootstrap applied:** state bucket `soa-tfstate-<account_id>` created with versioning, AES256 encryption, and full public-access block (`force_destroy = false`). Local state, one-time.
- **Root applied:** GitHub OIDC provider, `soa-deployer` role (trust locked to `repo:.../SOA_Final_Project:ref:refs/heads/main`), `soa-boundary` permissions boundary, and `soa-deployer-permissions` policy. State stored remotely in S3 with native locking (`use_lockfile`), confirmed working. `Plan: 5 to add, 0 to change, 0 to destroy`. Cost: ~$0.

**Deviations from the original plan (all captured in the Amendment block above):**
- DynamoDB lock table dropped in favour of S3-native locking (pre-execution decision).
- IAM hardened across **three** infra-reviewer rounds: added the permissions-boundary pattern (blocker), then self-escalation `Deny` statements after the boundary fix exposed a self-escalation path (blocker), plus a corrected boundary-tampering deny split. Final verdict: safe to apply.
- State bucket uses `force_destroy = false` (deletable-but-accident-protected) instead of a hard `prevent_destroy`, per user choice.
- Account ID kept out of committed code via a gitignored `backend.hcl` (+ committed `.example`); `init` uses `-backend-config=backend.hcl`.

**Prerequisites installed during execution:** AWS CLI + IAM user access-key credentials, Terraform 1.15.

**Operational note carried forward:** the pipeline (deployer role) cannot modify its own IAM — changes to `soa-deployer`'s role/policy require a human `terraform apply` with admin credentials.

**Outputs (for the future pipeline PRD, as GitHub Actions variables):** `deployer_role_arn`, `oidc_provider_arn` — read via `terraform output`, never committed.

Operational documentation: see `docs/operations/` (written by `documentation-keeper`). Decision context: [ADR 0001](../../architecture/decisions/0001-platform-and-compute-architecture.md).
