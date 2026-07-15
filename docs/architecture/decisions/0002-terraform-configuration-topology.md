# 0002 — Terraform Configuration Topology

> Terraform is split into three separate configs/states — `bootstrap/` (state bucket), the root identity foundation, and `app/` (billable infra) — so that cost-saving teardown never destroys the permanent, free identities the pipeline depends on.

- **Status:** Accepted — refined by [ADR 0003](0003-base-edge-split.md)
- **Date:** 2026-07-11

## Context

Two constraints, established in [ADR 0001](0001-platform-and-compute-architecture.md) and enforced during PRD [platform/0001](../../action_plan/platform/0001-terraform-foundation.md) and [platform/0002](../../action_plan/platform/0002-cicd-pipeline.md), collide if all Terraform lives in one config:

1. **Cost model — `terraform destroy` between sessions.** Only ECS + ALB cost money; the design tears the billable infra down to ~$0 when idle.
2. **The pipeline cannot recreate or modify the IAM identities.** `soa-deployer` can only create roles that carry the `soa-boundary` permissions boundary, and is explicitly denied from editing its own role/policy (the anti-escalation design). So a `terraform destroy` + pipeline re-apply of the identities **fails** — the deployer can't recreate `soa-ci-plan` or itself.

If the free, permanent identities (OIDC provider, `soa-deployer`, `soa-ci-plan`, `soa-boundary`) shared one config with the billable, destroyable infra, a routine cost-saving `terraform destroy` would wipe the identities and leave the pipeline unable to re-provision. The state bucket has this same "must survive destroy" property and was already isolated in `bootstrap/`.

## Decision

Use **three separate Terraform configurations, each with its own state**, distinguished by lifecycle and who applies them:

| Config | Contents | Applied by | Lifecycle |
| --- | --- | --- | --- |
| `terraform/bootstrap/` | S3 remote-state bucket | human, once | **Permanent** — never destroyed (see ADR 0001 / foundation runbook) |
| `terraform/` (root) | **Identity foundation** — GitHub OIDC provider, `soa-deployer` + `soa-ci-plan` roles, `soa-boundary`, their policies | **human** `terraform apply` (admin creds) | **Permanent** — free, not part of routine teardown; the pipeline can't modify its own IAM, so identity changes are human-applied |
| `terraform/app/` | **Billable app infra** — VPC/network, ECS cluster/services, ALB, ECR, DynamoDB, SQS/SNS, Lambda, CloudWatch, and the per-service **workload roles** (created with the `soa-boundary`) | the **pipeline** (`cd.yml`), via the `soa-deployer` OIDC role | **Destroyable** — `terraform destroy`ed between sessions to return spend to ~$0 |

The pipeline (`ci.yml` plan / `cd.yml` apply) targets **`terraform/app/`**. The identity foundation is applied by a human and is not touched by the pipeline in steady state. `terraform destroy` for cost saving is run against **`terraform/app/` only**.

## Consequences

- **Easier:** cost-saving teardown (`destroy app/`) never endangers the identities or state bucket; the "pipeline can't manage its own identity" tension disappears because the pipeline never applies the config that contains its own role.
- **Harder / accepted:** three configs to understand; the identity config is deliberately human-applied (changing `soa-deployer`/`soa-ci-plan` needs a local `terraform apply`, as seen in PRD 0002); `app/` needs its own `backend.tf` with a distinct state key.
- **Workload roles** (ECS task roles, Lambda execution roles) are created in `app/` by the deployer and therefore **must carry the `soa-boundary`** — the boundary condition on `soa-deployer`'s `iam:CreateRole` enforces this.

## Current state / transition

- `bootstrap/` and the root identity foundation **exist and are applied** (PRDs 0001 & 0002).
- `terraform/app/` **existed and was pipeline-applied** — created in [PRD platform/0003](../../action_plan/platform/0003-network.md) (the network foundation), which also **retargeted `ci.yml`/`cd.yml` from `terraform/` to `terraform/app/`**.
- Moving the identity `.tf` files into a `terraform/foundation/` subdirectory (so `terraform/` has no loose root config) was considered but deferred — it would require state migration for no functional gain; the root config stays as the identity foundation.
- **Refined by [ADR 0003](0003-base-edge-split.md) (PRD platform/0006):** the single `terraform/app/` config described above has since been split into `terraform/app-base/` (permanent, free — network, cluster, execution role, ALB SG, tables) and `terraform/app-edge/` (destroyable, billable — ALB + per-service compute); `terraform/app/` itself is retired. The lifecycle-split *principle* recorded in this ADR (permanent identity vs. destroyable billable infra) is unchanged — ADR 0003 applies it one level deeper, inside what was the billable tier. Routine `terraform destroy` now targets `terraform/app-edge/` specifically, not a single `app/` config.

## Alternatives considered

- **Single root config for everything** — simplest to write, but a cost-saving `terraform destroy` wipes the identities and the pipeline can't rebuild them. Rejected.
- **`prevent_destroy` on every identity resource** — hard-blocks `destroy` on the shared config (errors out), messy, and doesn't separate lifecycles. Rejected in favour of physical config separation.
