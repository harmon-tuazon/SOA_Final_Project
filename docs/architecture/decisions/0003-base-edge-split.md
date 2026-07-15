# 0003 — Base/Edge Split: Permanent Free Foundation + Destroyable Billable Edge

> Split the billable app config into a permanent, free **`app-base`** (network, ECS cluster, shared execution role, ALB security group, and every service's DynamoDB table) and a destroyable, billable **`app-edge`** (the ALB + listener and every service's compute), with tables made self-serve for the pipeline but protected by an explicit `DeleteTable`/`DeleteBackup` IAM deny — so a routine cost-saving teardown never touches data, and a new service's table never needs a human `terraform apply`.

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

[ADR 0002](0002-terraform-configuration-topology.md) split Terraform into `bootstrap/` (state bucket), the root identity foundation, and a single `terraform/app/` config for all billable infrastructure — network, ECS, ALB, and every service's DynamoDB table — torn down wholesale between sessions to keep spend at ~$0.

That worked while there was one operator. [PRD platform/0006](../../action_plan/platform/0006-base-edge-split.md) targets a different situation — "Posture 2": **infra-blind teammates** adding services via `/new-service` with **no manual infrastructure step**, on top of a foundation that is **stable and always present** between work sessions, with each service's **data surviving** the routine teardown. Two things collide in the single-`app/`-config model:

1. **Cost model — the whole config gets destroyed.** `terraform destroy` against `terraform/app/` removes the network, cluster, ALB, *and every DynamoDB table* — a teammate's data doesn't survive a teardown cycle, and the foundation a new service is scaffolded onto isn't stable across sessions.
2. **Self-serve tables need the pipeline to create them.** For `/new-service` to be genuinely no-human-step, the pipeline (`soa-deployer`) must be able to create a new service's table on merge. But a role that can create a `soa-*` table can, by default, also delete or replace one — and an unattended `apply` that happens to trigger a destroy-and-recreate (e.g. a `hash_key` change, or an accidentally-deleted `data` block) would silently wipe that service's data with no human in the loop.

Splitting by lifecycle (as ADR 0002 already did for identity vs. app) resolves (1); resolving (2) needs an IAM control, not just a config boundary, since Terraform itself would otherwise happily destroy-and-recreate a table on a plan that calls for it.

## Decision

Split the billable app tier into **two sibling Terraform configs**, each with its own state key in the existing shared S3 bucket (native locking, per ADR 0001/0002), both **pipeline-applied**:

| Config | Contents | Lifecycle |
| --- | --- | --- |
| **`terraform/app-base/`** (state key `app-base/terraform.tfstate`) | the `network` module (VPC/subnets/IGW/routes), the ECS cluster + shared task **execution role** + **ALB security group** (`modules/ecs-cluster/`), and every service's **`data`** (DynamoDB table) module | **Permanent, free, never destroyed.** Applied by the pipeline, but never part of the teardown cycle. |
| **`terraform/app-edge/`** (state key `app-edge/terraform.tfstate`) | the shared **ALB + HTTP listener** (`modules/alb/`, extracted out of `modules/ecs-cluster/`) and every service's **`ecs-service`** module (task role, target group, listener rule, task definition, ECS service, autoscaling) | **Destroyable, billable.** This is what `terraform destroy` targets between sessions. |

Both configs source their resource-creating logic from the same shared module tree, `terraform/modules/` (`network`, `ecs-cluster`, `alb`, `data`, `ecs-service`) — not a copy per config.

- **Cross-config wiring — `terraform_remote_state`:** `app-edge` reads `app-base`'s outputs (`vpc_id`, `public_subnet_ids`, `cluster_id`, `execution_role_arn`, `alb_sg_id`) via a `data "terraform_remote_state" "base"` block pointed at `app-base`'s state key in the same bucket (`terraform/app-edge/main.tf:19-27`). A service's table ARN is *not* read back through remote state per service — it's constructed as a string (`arn:aws:dynamodb:<region>:<account>:table/soa-<name>`, the same pattern already used for the `soa-boundary` ARN) so adding a service needs no new remote-state read.
- **Tables live in BASE.** A service is declared with one module block in each config — `module "<name>_table"` (the `data` module) in `app-base/main.tf`, `module "<name>_service"` (the `ecs-service` module) in `app-edge/main.tf`. Because the table lives in the config that's never destroyed, a service's data survives every `app-edge` teardown/recreate cycle.
- **Self-serve + deny-delete IAM posture (`terraform/iam.tf`, human-applied root config):** `soa-deployer` gains a scoped statement (`DynamoDbTableLifecycleManagement`) granting `dynamodb:CreateTable`, `UpdateTable`, `DescribeTable`, `TagResource`/`UntagResource`, `UpdateTimeToLive`/`DescribeTimeToLive`, `UpdateContinuousBackups`/`DescribeContinuousBackups`, scoped to `arn:aws:dynamodb:*:<account>:table/soa-*` — **not account-wide**, and deliberately *not* including `DeleteTable`/`DeleteBackup`. A second, explicit statement (`DenyDynamoDbTableDeletion`) **Denies** `dynamodb:DeleteTable` and `dynamodb:DeleteBackup` on that same `soa-*` scope. IAM deny always wins regardless of any Allow elsewhere in the policy (including the broader pre-existing `dynamodb:*` `DynamoDbManagement` statement) — so the pipeline can bring a new table into existence and keep it tagged/configured, but **can never remove one**. A Terraform change that would otherwise resolve as destroy-and-recreate (a `hash_key` change, or a deleted `data` block) fails the apply with `AccessDenied` instead of silently dropping the table.

This is a **human-applied, one-time IAM change** against the root identity config — `soa-deployer` cannot edit its own policy (ADR 0002 / the self-edit denies), so it was applied locally with admin credentials, same as every other deployer-permission grant.

## Consequences

- **Teardown targets `app-edge` only.** Routine cost-saving teardown is `terraform -chdir=terraform/app-edge destroy` — it removes the ALB and every service's compute; `app-base` (network, cluster, roles, and every table's data) is untouched and a subsequent `app-base plan` shows zero changes. See [operations/cost-lifecycle.md](../../operations/cost-lifecycle.md) for the full procedure.
- **The ALB's DNS name churns on every teardown/recreate cycle** (a new `aws_lb` gets a new DNS name each time `app-edge` is recreated). This makes the existing "config from environment, not hardcoded" service contract rule carry new weight: **no service or frontend may hardcode an ALB DNS name or endpoint** — the API base URL is always read from config/env. See [`service-contract.md`](../../../.claude/rules/service-contract.md)'s no-hardcoded-endpoint rule. This is also forward-compatible groundwork for a future Route 53 custom domain (deferred; see PRD platform/0006 §3 out-of-scope) — swapping in a stable domain becomes a one-value config change instead of a code change.
- **The deployer's IAM scope grows, but stays fail-closed.** `soa-deployer` can now create/update `soa-*` DynamoDB tables with no human step — a real (if narrow) widening of what the keyless pipeline can do. The explicit `DeleteTable`/`DeleteBackup` deny is what keeps this safe: even a mistaken Terraform plan that would delete a table cannot execute, it errors instead. This is the same "deny beats every allow, including a broader pre-existing grant" pattern already used elsewhere in `terraform/iam.tf` for the boundary and deployer self-edit denies.
- **`app-base` applies are a near-no-op most of the time** — only a new service's table (or, rarely, a network/cluster change) produces a diff; the common case (a service's app code or task definition changing) is entirely an `app-edge` apply.
- **Harder / accepted:** a service is now authored across two Terraform configs instead of one (`/new-service` and `adding-a-service.md` write both blocks in one PR); two `backend.tf`s, two state keys, and a remote-state read to reason about instead of one config.

## Supersedes / refines

This **refines** [ADR 0002](0002-terraform-configuration-topology.md) — it does not overturn ADR 0002's core principle (identity/bootstrap/app split by lifecycle, so a cost-saving teardown never endangers something permanent). It instead applies that same principle **one level deeper**, splitting ADR 0002's single billable `terraform/app/` config into the permanent `app-base` and destroyable `app-edge` halves described above, because "billable and destroyable" turned out not to be one lifecycle but two once persistent-across-teardown data entered the picture. ADR 0002 has been updated with a cross-reference to this ADR; its record of the original single-`app/`-config decision is left intact.

## Alternatives considered

- **Human-applied `app-base` (tables created by hand).** Considered first (see PRD platform/0006 §9, "the earlier human-applied BASE lean"). Rejected: it reintroduces exactly the manual infra step Posture 2 is meant to remove — a teammate's `/new-service` PR would need a human to run `terraform apply` against `app-base` before the table exists, breaking the "no manual step" goal.
- **Grant `soa-deployer` full `dynamodb:DeleteTable`.** Rejected — it is the exact power that lets an unattended `apply` wipe a table's data; the whole point of the split is to make that impossible, not just unlikely.
- **Single `app/` config with `prevent_destroy` on each table resource.** Considered as a lighter-weight alternative to a full config split. Rejected for the same reason ADR 0002 rejected `prevent_destroy` on the identity resources: it hard-errors the *entire* `terraform destroy` the moment it reaches a protected resource, rather than cleanly separating "destroy this" from "keep that" — there is no way to `destroy` the ALB and services while leaving `prevent_destroy`'d tables in the same state without the apply/destroy erroring on every run.
