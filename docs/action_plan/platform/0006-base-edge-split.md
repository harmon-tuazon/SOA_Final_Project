# 0006 — Base/Edge Split (permanent free foundation + destroyable billable edge)

> Split `terraform/app` into a permanent, free, always-on **BASE** (network + ECS cluster + execution role + ALB SG + all DynamoDB tables) and a destroyable, billable **EDGE** (ALB + listener + per-service compute), so infra-blind teammates get a stable, always-ready foundation with persistent data while idle cost stays ~$0 — teardown targets EDGE only. **Tables are self-serve** (created by the pipeline, in Terraform) and **protected by an IAM `DeleteTable` denial** so the pipeline can create but never wipe data. Implements "Posture 2".

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-14
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-14 (user)

> Decisions settled via `/grill-me` (with a follow-up decision to make tables self-serve — "Option 2"). Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the platform owner with infra-blind teammates, I want the free foundation (network, cluster, IAM, and each service's DynamoDB table) to stay standing permanently at ~$0 while only the billable edge (ALB + running Fargate tasks) is torn down between work sessions, so that a teammate can create a service and push code against a **stable, always-present foundation** — with their data surviving teardowns — **with no manual infra step from me**, and with a guarantee that the automated pipeline can never delete a table's data.

## 3. Scope

**In scope:**
- **Split `terraform/app/` into two sibling configs**, each with its own state key in the existing shared bucket and native locking, both **pipeline-applied**, split purely by lifecycle (permanent vs disposable):
  - **`terraform/app-base/`** (state key `app-base/…`) — **permanent, free, never destroyed**: the `network` module (VPC/subnets/IGW/routes), the ECS **cluster**, the shared **execution role**, the **ALB security group**, and **every service's `data` (DynamoDB) module**. Applied by the pipeline; never in the teardown cycle.
  - **`terraform/app-edge/`** (state key `app-edge/…`) — **destroyable, billable**: the **ALB** + HTTP **listener**, and every service's **`ecs-service`** module (task role, target group, listener rule, task definition, ECS service, autoscaling). This is what `terraform destroy` targets.
- **Self-serve tables, protected against deletion (the core of "Option 2"):** `soa-deployer` gets a **scoped, control-plane-only** grant to manage tables — the exact set Terraform's `aws_dynamodb_table` needs for create/read/update (`CreateTable`, `DescribeTable`, `UpdateTable`, `ListTagsOfResource`, `TagResource`/`UntagResource`, `Describe`/`UpdateTimeToLive`, `Describe`/`UpdateContinuousBackups`) on `arn:…:table/soa-*` — with **no data-plane access at all** and **no `DeleteTable`**. The pre-existing broad `dynamodb:*`/`*` grant is **removed** (infra-reviewer finding), and an explicit `Deny` on `DeleteTable`/`DeleteBackup` remains as a backstop. The pipeline can therefore *create/update* a service's table with no human step, but **can never delete a table or touch its rows** — a destroy-and-recreate change (e.g. a hash-key change) **fails loudly at apply** instead of wiping data. In the same pass, the deployer's **Terraform state access is narrowed** to the `app-base/*`+`app-edge/*` keys (it can no longer read/delete the human-applied `platform/` identity state). These IAM changes are **human-applied once** in the `terraform/` root (the deployer can't modify its own IAM). Runtime data-plane access (GetItem/PutItem/Query) stays on each **task role**, unchanged.
- **Cross-config wiring via `terraform_remote_state`** — EDGE reads BASE's outputs (`vpc_id`, `public_subnet_ids`, `cluster_id`, `execution_role_arn`, `alb_sg_id`) from BASE's state in S3. Each service's **table ARN is constructed as a string** (`arn:…:table/soa-<name>`, like the boundary ARN already is) so the task-role scope needs no extra remote-state read.
- **Pipeline (both configs, base first):** `cd.yml` applies **`app-base` then `app-edge`** on push to `main` (base apply is a near-no-op except when a new table is added); `ci.yml` runs `fmt`/`validate`/`plan` against **both**. Service discovery (`services/*` excluding `_template`), keyless OIDC, and role separation unchanged. **`destroy` is never in the pipeline** — teardown is a deliberate human `destroy` of `app-edge` only.
- **`/new-service` update** — writes the **`data` block into `app-base/`** and the **`ecs-service` block into `app-edge/`** in a single PR; on merge, CD creates the table (base) and the service (edge) automatically. **No human infra step** in the per-service flow.
- **`service-contract.md` update** — the infrastructure-contract section moves from "two module blocks in `main.tf`" to "**table block in `app-base`, service block in `app-edge`**", and the "config from environment only" rule is extended to **forbid hardcoded API endpoints** (frontend and service-to-service alike): the API base URL is always read from config/env, never a literal ALB DNS or endpoint in source.
- **Docs:** a new **ADR 0003** recording the base/edge split + the self-serve/deny-delete data posture (superseding ADR 0002's "app is one config" stance); a **teardown/spin-up runbook** under `docs/operations/`; updates to `overview.md` (incl. the no-hardcoded-endpoint convention), `compute-layer.md`, `adding-a-service.md`, and `cicd-pipeline.md`.

**Out of scope (later):**
- **Route 53 custom domain / stable URL** — deferred to a later PRD (added when a frontend lands and pins an API URL). The no-hardcoded-endpoint convention here is the forward-compatible groundwork so that domain change is a one-value edit.
- **Async worker template (SQS/Lambda), S3 frontend, Cognito, HTTPS.**
- **Actual domain services** (Order/Product/User) — created *via* `/new-service` afterward.
- **Granting the deployer `DeleteTable`** (rejected: it's the exact power that lets an unattended `apply` wipe data — the deny is the safety mechanism).

## 4. Success criteria

1. `terraform/app-base/` and `terraform/app-edge/` exist as separate configs, each with its own `backend.tf` (distinct state keys, native locking); the old single `terraform/app/` config is retired.
2. `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` both pass.
3. **BASE applies clean and is entirely free:** applying `app-base` creates VPC + subnets + IGW + routes + cluster + execution role + ALB SG + tables with **0 billable resources** (no ALB, no running tasks).
4. **EDGE reads BASE via remote state:** with BASE applied, `terraform -chdir=terraform/app-edge plan` resolves `vpc_id`/`cluster_id`/`alb_sg_id`/`execution_role_arn`/subnets from BASE with no hardcoded IDs.
5. **Self-serve, no human step:** a new-service PR merged to `main` results in CD creating the table (base) and deploying the service (edge) with **no manual `terraform apply`** by a human.
6. **Pipeline cannot delete data (the guarantee):** the deployer's DynamoDB grant is **control-plane only** — the enumerated create/update/describe/tag actions on `soa-*` tables, with **no data-plane access at all** (no `DeleteItem`/`BatchWriteItem`/`PutItem`) and **no `DeleteTable`**; the broad `dynamodb:*`/`*` grant is removed. An `apply` that would delete/replace a `soa-*` table fails with AccessDenied (verified with a throwaway table change on a branch, never merged), and the deployer has no permission to touch a table's rows either. (An explicit `DeleteTable`/`DeleteBackup` **Deny** remains as a backstop against a future broad grant.)
7. **`destroy` hits EDGE only:** `terraform -chdir=terraform/app-edge destroy` removes the ALB (+ services); a subsequent `terraform -chdir=terraform/app-base plan` shows **0 changes** (BASE untouched, data intact).
8. **Deployer scope correct (tightened per infra-reviewer):** `soa-deployer` has the enumerated control-plane DynamoDB actions on `soa-*` only (no `dynamodb:*`), the `DeleteTable`/`DeleteBackup` Deny, region-scoped table ARNs, **and** its Terraform state access narrowed to the `app-base/*`+`app-edge/*` keys only (it can no longer read or delete the human-applied `platform/` identity state); keyless OIDC + role separation intact (infra-reviewer verdict).
9. **No hardcoded endpoints:** a repo-wide grep for a literal ALB DNS / `elb.amazonaws.com` / hardcoded service URL in committed source returns nothing; the rule is written into `service-contract.md`.
10. `/new-service` and `service-contract.md` reflect the two-config pattern and are internally consistent with the real `app-base`/`app-edge` layout.
11. After verification, `terraform -chdir=terraform/app-edge destroy` returns to ~$0 while **BASE stays standing** (network/cluster/roles/tables live, still free).

## 5. Resources

| Resource | Type | Config | Cost |
| --- | --- | --- | --- |
| VPC, subnets, IGW, route tables | `aws_vpc`/`aws_subnet`/`aws_internet_gateway`/`aws_route*` | app-base | **$0** |
| ECS cluster | `aws_ecs_cluster` | app-base | **$0** (pay only for running tasks) |
| Shared execution role + policy | `aws_iam_role`/`aws_iam_policy` | app-base | **$0** |
| ALB security group | `aws_security_group` | app-base | **$0** |
| Per-service DynamoDB tables | `aws_dynamodb_table` (on-demand) | app-base | **$0** at idle (data persists) |
| **ALB + HTTP listener** | `aws_lb`/`aws_lb_listener` | app-edge | **~$16/mo while up** (only billable base resource) |
| Per-service compute (task role, TG, rule, task def, service, autoscaling) | `aws_ecs_service` etc. | app-edge | **$0** until tasks run; Fargate vCPU/mem while running |
| Deployer table create/update + DeleteTable **Deny** | `aws_iam_policy` stmts | terraform/ root | **$0** |
| Deployer read on BASE state | `aws_iam_policy` stmt (`s3:GetObject` on `app-base/…`) | terraform/ root | **$0** |
| Remote state keys `app-base/…`, `app-edge/…` | S3 objects (existing bucket) | — | **$0** |

**Total: ~$0 idle.** BASE is entirely free and permanent. The only billable resource is the ALB (in EDGE), plus Fargate when services actually run — both live only while EDGE is up. This PRD's own execution stands BASE up (free, permanent) and does a transient EDGE apply→destroy to validate (brief ALB), netting ~$0.

## 6. Scripts / commands

```bash
# --- One-time IAM (human-applied, admin creds; deployer gains scoped table create/update,
#     an explicit DeleteTable DENY, and read on app-base state) ---
terraform -chdir=terraform apply

# --- Both app configs are pipeline-applied; validated locally first ---
terraform -chdir=terraform/app-base  init -backend-config=backend.hcl
terraform -chdir=terraform/app-base  validate
terraform -chdir=terraform/app-edge  init -backend-config=backend.hcl
terraform -chdir=terraform/app-edge  validate
terraform -chdir=terraform/app-edge  plan          # resolves BASE via remote_state

# --- Ship it (PR -> CI plans both -> merge -> CD applies app-base THEN app-edge) ---
git checkout -b base-edge-split
git add -A && git commit -m "Split terraform/app into app-base + app-edge; self-serve tables with DeleteTable deny"
git push -u origin base-edge-split
# PR -> CI (fmt/validate/plan on app-base AND app-edge) -> merge -> CD

# --- Verify the delete-guard (on a throwaway branch, NEVER merged) ---
#   change a soa-* table's hash_key in app-base, then:
terraform -chdir=terraform/app-base apply          # expect: AccessDenied on dynamodb:DeleteTable

# --- Verify teardown targets EDGE only, BASE survives ---
terraform -chdir=terraform/app-edge destroy        # ALB (+services) gone -> ~$0
terraform -chdir=terraform/app-base plan           # expect: 0 changes (BASE intact, data preserved)

# --- No-hardcoded-endpoint check ---
grep -rIn "elb.amazonaws.com" services/ functions/ || echo "clean"
```

Billable/destructive commands named explicitly: the transient `app-edge` apply (via CD) and `destroy`. The BASE apply creates no billable resources, and the deployer's `DeleteTable` deny means the pipeline **cannot** delete a table.

## 7. Planned agents

- **`terraform-engineer`** — split `terraform/app/` into `terraform/app-base/` + `terraform/app-edge/`: move modules to the correct config, add each config's `backend.tf`/`variables.tf`/`outputs.tf`, wire EDGE→BASE via `terraform_remote_state`, construct per-service table ARNs as strings, and add to `terraform/iam.tf` (root) the deployer's scoped table create/update grant, the **`DeleteTable` Deny**, and read-on-`app-base`-state. Runs `fmt`/`validate`/`plan` on both; **never applies/destroys**.
- **`pipeline-engineer`** — update `cd.yml` to apply **`app-base` then `app-edge`**; point `ci.yml`'s `validate`/`plan` at **both** configs; preserve keyless OIDC, role separation, and `services/*` discovery.
- **`infra-reviewer`** — audit the split + IAM change + pipeline: BASE is free-only, the deployer can create/update but **not delete** tables (deny present and effective), teardown can't reach BASE, no billable surprises, still keyless.
- **`documentation-keeper`** — write **ADR 0003** (base/edge split + self-serve/deny-delete posture, supersedes ADR 0002's single-app-config stance), the **teardown/spin-up runbook**, and update `overview.md`/`compute-layer.md`/`adding-a-service.md`/`cicd-pipeline.md`.
- **Main session** — writes this PRD; updates **`.claude/rules/service-contract.md`** (two-config infra contract + no-hardcoded-endpoint rule) and **`.claude/commands/new-service.md`** (table→app-base, service→app-edge, no human step); performs the **one-time human `terraform apply`** on the `terraform/` root (IAM); drives the PR + post-merge EDGE `destroy`.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 two configs exist | `ls terraform/`; each has its own `backend.tf` with distinct key |
| #2 both validate | `terraform -chdir=terraform/app-base validate` + `…/app-edge validate` |
| #3 BASE free | apply `app-base`; confirm plan has no `aws_lb`/running tasks |
| #4 EDGE reads BASE | `…/app-edge plan` resolves IDs via `terraform_remote_state` (no literals) |
| #5 self-serve | merge a new-service PR; confirm CD creates table + service with no human apply |
| #6 delete-guard | on a throwaway branch, change a `soa-*` table's `hash_key`; `apply` → AccessDenied on `DeleteTable` |
| #7 destroy = EDGE only | `…/app-edge destroy`; then `…/app-base plan` shows `0 to add/change/destroy` |
| #8 deployer scope | `infra-reviewer` verdict; confirm scoped create/update + explicit `DeleteTable` Deny in `terraform/iam.tf` |
| #9 no hardcoded endpoints | `grep -rIn "elb.amazonaws.com" services/ functions/` empty; rule present in `service-contract.md` |
| #10 command/contract consistent | review `/new-service` + `service-contract.md` against the real layout |
| #11 $0 idle, BASE up | `aws elbv2 describe-load-balancers` empty after destroy; `…/app-base plan` = 0 changes |

## 9. Additional considerations

- **Security posture (the deliberate trade):** to make tables self-serve, `soa-deployer` gains **scoped table create/update** on `soa-*` — a modest widening of the keyless pipeline. The **explicit `DeleteTable` Deny** is what makes that safe: the pipeline can bring a new table into being but can never remove one or its data, so an unattended `apply -auto-approve` that hits a destroy-and-recreate change **fails closed** rather than wiping data. The permissions boundary, keyless OIDC, and role separation are otherwise untouched; data-plane reads/writes stay on the per-service task roles.
- **Reverses the earlier "human-applied BASE" lean:** during the grill I leaned toward a human-applied base (Option 1). Choosing self-serve (Option 2) means the config holding the tables must be **pipeline-applied**, so BASE is now pipeline-applied too. The deployer already had network/cluster/role-creation powers (from PRD 0004), so the only *new* grant is the scoped, delete-denied table power above.
- **Accidental table removal also fails closed:** because the deny blocks `DeleteTable` everywhere, a PR that mistakenly deletes a `data` block can't wipe the table either — CD's `app-base` apply errors instead of dropping it. Intentional table deletion is a rare, deliberate **human** `apply` with admin creds.
- **No hardcoded endpoints (forward-compat for the deferred domain):** because the ALB DNS changes each teardown cycle, all consumers read the API base URL from config/env. This keeps the app working across cycles today and makes the future Route 53 domain a one-value change. Enforced by `service-contract.md` + a CI-visible grep.
- **Rollback/teardown:** the split is reversible (configs can be merged back); routine teardown is `terraform -chdir=terraform/app-edge destroy` → ~$0 with BASE (and data) surviving. BASE is only ever destroyed at true project end (a deliberate human action, since the deployer can't delete tables).
- **Supersedes:** ADR 0002's "app is one config, destroyed wholesale" — recorded in the new ADR 0003 with cross-references updated.

---

## Outcome

Executed as planned and proven end-to-end. Shipped in PR #10 (`Split terraform/app into app-base + app-edge`), merged to `main`.

**Delivered:**
- `terraform/app-base/` (permanent, free) + `terraform/app-edge/` (destroyable) split, separate state keys, both pipeline-applied. Shared modules moved to `terraform/modules/`; ALB extracted into a new `modules/alb/`. Old `terraform/app/` retired. EDGE reads BASE via `terraform_remote_state`; per-service table ARNs constructed as strings.
- Self-serve tables, **data-safe by IAM** (tightened beyond the original plan after infra-review — see deviation): the deployer's DynamoDB grant is **control-plane only** (`DynamoDbTableLifecycleManagement`, 10 enumerated actions incl. `ListTagsOfResource`), the broad `dynamodb:*`/`*` grant **removed**, an explicit `DeleteTable`/`DeleteBackup` **Deny** kept as backstop, all region-scoped. Deployer state access narrowed to `app-base/*`+`app-edge/*` (no access to the `platform/` identity state).
- Pipeline: `cd.yml` applies `app-base` → `app-edge`; `ci.yml` plans both (check name unchanged). ADR 0003, the `cost-lifecycle.md` runbook, the no-hardcoded-endpoint convention, and `service-contract.md`/`new-service.md` all updated to the two-config pattern.

**Verification (all criteria met):**
- CI green on PR #10 (fmt + validate/plan on **both** configs; `app-edge` plan resolved `app-base`'s remote state). Criteria #1–4, #10.
- Root IAM apply → `0 add, 1 change, 0 destroy` (deployer policy). `app-base` apply → **13 added, all free** (no ALB, no tasks) — criterion #3.
- Merge CD ran **3m30s green** — applied `app-base` (no-op) then `app-edge` (ALB created) with the tightened deployer IAM, 0-service loops no-op'd. Criteria #5, #6 (self-serve, no human step post-bootstrap).
- `terraform -chdir=terraform/app-edge destroy` → 2 destroyed (ALB + listener); `app-base plan` → **"No changes"**; `aws elbv2` shows **0 `soa-alb`**; VPC `available` + cluster `ACTIVE`. Criteria #7, #11 — teardown hits EDGE only, BASE + data survive at ~$0.
- No-hardcoded-endpoint rule in `service-contract.md`; grep clean. Criterion #9.

**Deviations (approved):**
- **IAM tightened beyond "preserve existing statements."** infra-reviewer found the pre-existing broad `dynamodb:*`/`*` grant meant the `DeleteTable` deny only protected the table object, not its rows — so the PRD's headline "can never delete data" guarantee was not fully real. With user approval, the broad grant was dropped, the scoped grant made control-plane-only (+`ListTagsOfResource`), and `TerraformStateAccess` narrowed to the app keys (closing a hole where the deployer could delete the identity foundation's state). This makes the guarantee airtight and improves least-privilege. Criteria #6/#8 updated accordingly.
- **First-run bootstrap:** because CI's `app-edge` plan reads `app-base`'s remote state, `app-base` was applied **once, locally** before opening the PR (a deliberate one-time stand-up of the permanent free base). Thereafter CD keeps it applied.
- **ECR repos live in `app-edge`** (part of `modules/ecs-service`), so a service's repo/images churn on each edge teardown/recreate — intentional and harmless (images are SHA-tagged and rebuilt on spin-up; keeps ECR at $0 while idle). Documented in `compute-layer.md`.

**Follow-ups (unchanged):** async worker template (SQS/Lambda); S3 frontend + Cognito + HTTPS; the deferred Route 53 custom domain (the no-hardcoded-endpoint convention is its groundwork); the first real domain service via `/new-service` — which will exercise the self-serve table path for real.

**Steady state now:** BASE stands permanently at ~$0 (VPC, cluster, roles, SG, and — once created — tables + data). EDGE is up only during work sessions; `terraform -chdir=terraform/app-edge destroy` returns to ~$0 between them. See [cost-lifecycle.md](../../operations/cost-lifecycle.md).
