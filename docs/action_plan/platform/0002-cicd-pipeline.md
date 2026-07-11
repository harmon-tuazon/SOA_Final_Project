# 0002 — CI/CD Pipeline (Infrastructure)

> Stand up GitHub Actions CI/CD for the Terraform infrastructure: `ci.yml` runs fmt/validate/plan on pull requests (read-only role), `cd.yml` runs apply on `main` (deployer role), both keyless via the OIDC foundation from PRD 0001. App/container build+deploy steps are deferred to later per-service PRDs.

## 1. Status & metadata

- **Status:** Approved
- **Date:** 2026-07-11
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-11 (user)

> Decisions below were settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the developer of this project, I want every infrastructure change to be automatically checked on a pull request and automatically applied when it merges to `main` — using the keyless OIDC roles already built — so that infra changes are reviewed before they land, applied consistently (not from my laptop), and never depend on long-lived AWS keys.

## 3. Scope

**In scope:**
- **`.github/workflows/ci.yml`** — triggers on **pull requests targeting `main`**. Runs `terraform fmt -check`, `terraform init` (remote backend), `terraform validate`, and `terraform plan -lock=false`. Authenticates to AWS via **OIDC as a new read-only `soa-ci-plan` role**. Runs on every PR (no path filter — see §9).
- **`.github/workflows/cd.yml`** — triggers on **push to `main`** filtered to `paths: terraform/**`. Runs `terraform init` + `terraform apply -auto-approve`. Authenticates via **OIDC as `soa-deployer`** (from PRD 0001).
- **A new `soa-ci-plan` IAM role** added to `terraform/iam.tf`: read-only permissions (AWS-managed `ReadOnlyAccess`, or a scoped read policy — infra-reviewer to weigh in), trust restricted to **pull-request** runs of this repo (`sub = repo:harmon-tuazon/SOA_Final_Project:pull_request`). No permissions boundary needed (not a workload role; created by human apply, not by the deployer).
- **GitHub Actions variables** (non-sensitive identifiers, not secrets): `AWS_REGION`, `TF_STATE_BUCKET`, `AWS_DEPLOY_ROLE_ARN`, `AWS_PLAN_ROLE_ARN`.
- **Branch protection on `main`**: require a pull request before merging, and require the CI status check to pass.

**Out of scope (later PRDs):**
- Any Docker build, ECR push, ECS deploy, or Lambda package/publish steps (no app/services exist yet).
- Per-service CI (lint/test) and path-filtered per-service jobs.
- Posting the plan as a PR comment (nice-to-have).
- A production/staging environment split or manual approval gates (we chose auto-apply).

## 4. Success criteria

1. `terraform validate` + `plan` pass after adding `soa-ci-plan`; plan shows the new role/policy to add, 0 destroys.
2. Opening a PR that changes `terraform/**` triggers `ci.yml`, which authenticates via OIDC as `soa-ci-plan` and completes `fmt`/`validate`/`plan` green — proving keyless CI auth.
3. Merging that PR to `main` triggers `cd.yml`, which authenticates via OIDC as `soa-deployer` and completes `terraform apply` — proving keyless CD auth end-to-end.
4. A direct `git push` to `main` is rejected by branch protection; a PR cannot be merged while its CI check is red.
5. No long-lived AWS keys exist anywhere in the repo, workflows, or GitHub secrets — only the four non-sensitive Actions **variables**.
6. `infra-reviewer` passes on both the Terraform IAM change and the two workflows.

## 5. Resources

| Resource | Type | Cost impact |
| --- | --- | --- |
| `soa-ci-plan` role + read-only policy attachment | `aws_iam_role`, `aws_iam_role_policy_attachment` | Free |
| GitHub Actions variables (×4) | GitHub repo config | Free |
| Branch protection rule on `main` | GitHub repo config | Free |
| `ci.yml`, `cd.yml` | Workflow files | Free (GitHub Actions minutes — well within free tier) |

**Total cost impact: ~$0.** No AWS compute; GitHub Actions minutes are free-tier for this volume.

External references: `aws-actions/configure-aws-credentials` (OIDC), `hashicorp/setup-terraform`, GitHub OIDC subject-claim docs, `gh api`/branch-protection docs.

## 6. Scripts / commands

Executed by the **user** (per their preference), with commands provided step-by-step. Order matters.

```bash
# 1. Add the soa-ci-plan role to terraform, review, then apply (human, admin creds)
cd terraform
terraform init -backend-config=backend.hcl   # if not already initialized
terraform plan                                # review: soa-ci-plan role/policy to add
terraform apply                               # ⚠️ creates soa-ci-plan (read-only role)

# 2. Capture the role ARNs + bucket for the Actions variables
terraform output deployer_role_arn
terraform output ci_plan_role_arn             # new output added by this PRD

# 3. Set the four GitHub Actions VARIABLES (gh CLI or GitHub UI)
gh variable set AWS_REGION --body "us-east-1"
gh variable set TF_STATE_BUCKET --body "soa-tfstate-<account_id>"
gh variable set AWS_DEPLOY_ROLE_ARN --body "<deployer_role_arn>"
gh variable set AWS_PLAN_ROLE_ARN --body "<ci_plan_role_arn>"

# 4. Add the workflows on a branch and open a PR (this PR itself exercises ci.yml)
git checkout -b add-cicd
git add .github/workflows/ci.yml .github/workflows/cd.yml
git commit -m "Add infrastructure CI/CD workflows"
git push -u origin add-cicd
# open the PR on GitHub -> watch ci.yml run

# 5. After merge, enable branch protection on main (gh CLI or UI)
#    require a PR + require the CI check to pass
```

## 7. Planned agents

- **`terraform-engineer`** — add the `soa-ci-plan` role (read-only, PR-scoped trust) + its policy + a `ci_plan_role_arn` output to `terraform/iam.tf`/`outputs.tf`. Runs fmt/validate/plan (plan-only). Hands off validated code.
- **`pipeline-engineer`** — write `ci.yml` and `cd.yml`; provide the exact `gh` commands for the four Actions variables and the branch-protection rule (the user runs them). Knows the OIDC pattern and the `permissions: id-token: write` scoping.
- **`infra-reviewer`** — review the IAM change (read-only, PR-trust scoped, no over-grant) **and** the workflows (OIDC role scoping, `permissions` minimalism, no secrets, CI never assumes the deployer role, CD only on `main`).
- **Main session** — orchestrates; hands the user the ordered commands. The user runs all `terraform apply` / `gh` / `git` commands.
- **`documentation-keeper`** — after execution, add a `docs/operations/` pipeline doc (stages, triggers, the two roles, how to add a variable) and update indexes.

## 8. Testing / verification plan

| Success criterion | Verification |
| --- | --- |
| #1 plan clean | `terraform plan` shows `soa-ci-plan` role/policy to add, 0 destroys (terraform-engineer + user) |
| #2 CI keyless | Open a PR touching `terraform/`; `ci.yml` run shows OIDC assume `soa-ci-plan` and green fmt/validate/plan |
| #3 CD keyless | Merge the PR; `cd.yml` run shows OIDC assume `soa-deployer` and a successful `terraform apply` |
| #4 protection | Attempt `git push origin main` directly → rejected; confirm merge blocked while CI red |
| #5 no keys | `infra-reviewer` + manual check: no `aws_access_key`, no `credentials_json`, no secrets — only the 4 variables |
| #6 review | `infra-reviewer` verdict on IAM change + both workflows |

## 9. Additional considerations

- **Security posture:** both roles keyless via OIDC. `soa-ci-plan` is **read-only** and its trust is scoped to `pull_request` runs; `soa-deployer` stays scoped to `main`. Workflows grant `permissions: id-token: write` only where the OIDC step needs it; CI **never** assumes the deployer role. No application secrets are involved (infra-only).
- **`-lock=false` on CI plan:** keeps `soa-ci-plan` genuinely read-only (a state lock would require an S3 write). Safe because `plan` writes no state. `apply` on `main` still locks.
- **Path-filter asymmetry:** CD is filtered to `terraform/**` (safe — CD isn't a required check, so skipping it is harmless). CI is **not** filtered — it's a required check, and filtering a required check leaves it unreported and can wedge a PR's merge button. Per-service path filters (with an always-reports gate) come when there are multiple services to filter.
- **IAM identities live in the root config the pipeline applies:** because the deployer is denied from editing its own IAM (PRD 0001), and `soa-ci-plan` is created/changed by human apply, a pipeline `apply` only *reads* these identities in steady state. Changing the deployer/ci-plan roles themselves requires a human `terraform apply` — intended.
- **Prereqs:** the repo must be pushed to GitHub (done). `gh` CLI optional — the four variables and branch protection can be set in the GitHub UI instead.
- **Rollback/teardown:** workflows are just files (delete to disable); `soa-ci-plan` is removed by `terraform destroy`/removing it from `iam.tf`; branch protection and variables are removable via UI/`gh`. Nothing here bills.
- **Open risk (out of scope for a solo repo):** running `plan` on PRs is safe here because PRs come from your own branches. If external contributors could open PRs from forks, plan-on-PR with an assumable role would need the usual `pull_request_target`/fork hardening.

### Review follow-ups (tracked — not blocking this PRD)

Both surfaced by `infra-reviewer`; the pipeline is safe to run today. Neither is fixed here.

1. **IAM identities are not pipeline-recreatable after a full `terraform destroy`.** `soa-deployer` cannot recreate `soa-ci-plan` (boundary/`policy/soa-*` conditions fail) or itself (self-edit denies). So the OIDC provider, `soa-deployer`, `soa-ci-plan`, and the boundary must be **re-applied by a human with admin credentials** if they're ever destroyed. **Decided resolution:** the identities are a permanent, free foundation and are **excluded from routine teardown** — the current `terraform/` config holds only identities and is **never `terraform destroy`ed**; billable infrastructure (network/ECS/ALB, from the next PRD onward) goes in a **separate `terraform/app/` config/state** so a cost-saving `terraform destroy` only tears down that config and never touches the identities. This mirrors how `terraform/bootstrap/` (state bucket) is already separated. The network PRD implements the split; `docs/operations/` documents "do not destroy the foundation."
2. **`soa-ci-plan` `ReadOnlyAccess` includes data-plane reads (`dynamodb` items, `s3:GetObject`) that `terraform plan` never uses.** **Fixed in this PRD (option A):** a customer-managed `soa-ci-plan-data-read-deny` policy (`policy/soa-*`, so the deployer can still refresh it) is attached to `soa-ci-plan`, denying `dynamodb:GetItem/BatchGetItem/Query/Scan/PartiQLSelect` and `s3:GetObject` — with the `soa-tfstate-*` bucket **exempted via `NotResource`** so `plan` can still read remote state.

---

## Outcome

_Filled after execution._
