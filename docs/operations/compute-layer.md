# Compute Layer: ECS Fargate + ALB

How the shared ECS Fargate cluster and Application Load Balancer work, the two IAM roles every task carries, how the pipeline builds and deploys a service's image, and how the compute layer is torn down between sessions. Built by [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md), on top of the network foundation ([PRD platform/0003](../action_plan/platform/0003-network.md), [architecture/overview.md](../architecture/overview.md#network)); split across `app-base`/`app-edge` by [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md). Decision context: [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) (why ECS/Fargate + a single ALB), [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) (why this lives in a destroyable config, apart from identity), [ADR 0003](../architecture/decisions/0003-base-edge-split.md) (why that config is itself split into a permanent `app-base` and destroyable `app-edge`).

Module sources (shared between both configs): [`terraform/modules/ecs-cluster/`](../../terraform/modules/ecs-cluster/), [`terraform/modules/alb/`](../../terraform/modules/alb/), [`terraform/modules/ecs-service/`](../../terraform/modules/ecs-service/), [`terraform/modules/data/`](../../terraform/modules/data/). Wired in [`terraform/app-base/main.tf`](../../terraform/app-base/main.tf) (cluster, execution role, ALB SG, tables) and [`terraform/app-edge/main.tf`](../../terraform/app-edge/main.tf) (ALB, listener, per-service compute).

## 1. Cluster + ALB, split by lifecycle

The cluster and the ALB are no longer created by one module in one config — [ADR 0003](../architecture/decisions/0003-base-edge-split.md) split `modules/ecs-cluster/` (which used to own both) so the ALB, the only billable piece, lives in the destroyable config:

**In `app-base/` (`modules/ecs-cluster/`, permanent, free):**
- **`aws_ecs_cluster`** — the shared Fargate cluster every service's tasks run on. No per-service cluster.
- **ALB security group** — inbound `:80` open to the internet (the sole public entry point), open egress to reach tasks on whatever port they listen on. Lives in `app-base` (not with the ALB) so it persists across `app-edge` teardown/recreate and doesn't need re-authoring each cycle.
- The shared ECS task **execution role** (§2 below).

**In `app-edge/` (`modules/alb/`, destroyable, billable):**
- **One internet-facing ALB** (`aws_lb`), sitting in the two public subnets (read from `app-base` via remote state) — a deliberate cost trade from ADR 0001 (one ALB for every service, not one each). The ALB is the only billable resource this module tree creates directly (~$16/mo while it exists).
- **One HTTP `:80` listener** (`aws_lb_listener`) with a **default action of a fixed 404 response**. Each service adds its own **path-based listener rule** (`aws_lb_listener_rule`, in `modules/ecs-service/`, also in `app-edge`) on top of this shared listener — neither the cluster nor the ALB module ever knows which services exist.
- No HTTPS/ACM/domain yet (HTTP-only demo posture — see PRD platform/0004 §9).

A service's route is whatever `path_pattern` its listener rule matches (e.g. a service named `orders` would use `/orders*` — see the `route`/`priority` inputs in [`terraform/app-edge/main.tf`](../../terraform/app-edge/main.tf) and the naming conventions in [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md)). A path with no matching rule falls through to the listener's default 404. As of [PRD platform/0005](../action_plan/platform/0005-service-factory.md), no services are wired by default — services are added via [`/new-service`](../../.claude/commands/new-service.md) or the manual recipe in [adding-a-service.md](adding-a-service.md), which now writes one block into each config.

Because the ALB is recreated on every `app-edge` teardown/recreate cycle, its DNS name is not stable across sessions — see [architecture/overview.md](../architecture/overview.md#no-hardcoded-endpoints-project-wide-convention) for the no-hardcoded-endpoint convention this makes binding, and [cost-lifecycle.md](cost-lifecycle.md) for the teardown/spin-up procedure.

## 2. Two IAM roles per task — execution vs. task role

Every ECS task carries two distinct roles, kept separate on purpose, and now created in different configs by the base/edge split:

| Role | Created by | Config | Scope | Carries |
| --- | --- | --- | --- | --- |
| **Execution role** | `modules/ecs-cluster/` — **one, shared** across every service's task definition | `app-base` (permanent) | ECR pull + CloudWatch Logs write only, nothing else | Never the app's own data-plane permissions |
| **Task role** | `modules/ecs-service/` — **one per service** | `app-edge` (destroyable) | The service's own runtime permissions — DynamoDB actions scoped to exactly its own table(s) (`table_arns` input, constructed as an ARN string against the table `app-base` created) and their `index/*` sub-resources, nothing account-wide | The app's data-plane access |

There is nothing service-specific about pulling an image or writing logs, so the execution role is reused (and lives in the permanent config); there is everything service-specific about what data a service's code can touch, so the task role is minted per service — and, since it's meaningless without a running task, it lives in the destroyable config alongside the rest of that service's compute. See [`modules/ecs-cluster/main.tf`](../../terraform/modules/ecs-cluster/main.tf) (execution role + policy) and [`modules/ecs-service/main.tf`](../../terraform/modules/ecs-service/main.tf) (task role + policy).

Both roles are `soa-*` named and **must** carry `permissions_boundary = soa-boundary` — the deployer's `iam:CreateRole` is conditioned on that exact boundary (see [terraform-foundation.md](terraform-foundation.md)), so a service's `ecs-service` block that omits it fails CD's apply with `AccessDenied`. Both roles use customer-managed policies only (never AWS-managed, never inline) — the deployer's `AttachRolePolicy`/`PutRolePolicy` grants don't allow either.

## 3. Network exposure: public subnets, but not exposed

Tasks run in the same public subnets as the ALB (no NAT gateway, per ADR 0001) and get a public IP (`assign_public_ip = true`) so they can reach ECR without one. That public IP does **not** mean the task is reachable directly:

- The **task security group** allows the service's app port **only from the ALB's security group** — nothing else in the VPC, and nothing from the internet, can reach the container directly.
- Traffic path is always **internet → ALB (`:80`) → listener rule → target group → task (app port)**.

## 4. Pipeline: build, push, deploy

`cd.yml` is generalized ([PRD platform/0005](../action_plan/platform/0005-service-factory.md)) to loop over **every** service, handling 0..N of them, and — per [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) — now applies **`app-base` before `app-edge`** on each run, so the second apply always has a fresh `app-base` remote state to read. Within that, it sequences steps to solve the chicken-and-egg between "the ECR repo doesn't exist yet" and "the task needs a real image to go healthy":

1. **Apply `app-base`** — creates/updates the network, cluster, execution role, ALB SG, and any new service's table. Idempotent; usually a no-op unless a service was just added.
2. **Discover services** — list `services/*`, excluding the never-deployed `_template`, into a `$SERVICES` list. Each discovered `<name>` maps to a `module.<name>_service` block in `terraform/app-edge/main.tf` (naming convention: ECR repo + ECS service = `soa-<name>`, per [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md)). With zero services this list is empty and every step below no-ops.
3. **Targeted apply — ECR repo only, per service** (`terraform apply -target=module.<name>_service.aws_ecr_repository.this`, once per discovered service, against `app-edge`). The ECR repo is part of the `ecs-service` module and therefore lives in `app-edge` — **destroyable**, alongside the rest of a service's compute (`force_delete = true`, per [`modules/ecs-service/main.tf`](../../terraform/modules/ecs-service/main.tf)). This means the repo (and any images in it) is recreated **every time `app-edge` is torn down and brought back up**, not just on a service's very first-ever deploy — this targeted-apply-then-push sequencing is what makes that safe on every cycle, not only the first one.
4. **Build + push each image**, tagged with `$GITHUB_SHA` (never `:latest`) as `soa-<name>:$GITHUB_SHA`, to the repo from step 3. The registry (`<account>.dkr.ecr.<region>.amazonaws.com`) is derived from the caller's account ID and the configured region, not a per-service Terraform output — the registry is the same for every repo.
5. **One full `terraform apply -var="image_tag=$GITHUB_SHA"`** against `app-edge` — creates the rest of the edge stack (ALB, every discovered service's task def/service/autoscaling) and, on every run, points each task definition at its newly pushed tag. Terraform registering a new task-definition revision is what triggers ECS's rolling deploy — no separate `aws ecs update-service` call is needed. With zero services this step just applies the shared ALB + listener.
6. **`aws ecs wait services-stable`, per service** — blocks until each new task set is healthy behind the ALB (or the old one still is, in which case the wait times out and the job fails red — a bad deploy never reports green).

See [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml) for the exact commands — it applies `app-base` then `app-edge` in the sequence above. CI (`ci.yml`, on pull request) discovers the same `services/*` set (excluding `_template`), builds each one's Docker image (to catch Dockerfile errors), and `plan`s both configs — it does not push or apply either.

## 5. Deployer permissions: grows with new resource types

The `soa-deployer` role (assumed by `cd.yml`) only had network/IAM-adjacent permissions before PRD platform/0004. Standing up ECS/ALB for the first time in the account surfaced two gaps that a live `terraform apply` hit and that only a human could fix, since **the pipeline cannot modify its own IAM** (ADR 0002; `soa-deployer` cannot edit its own policy). Both were added by a human `terraform apply` against the root identity config (`terraform/iam.tf`), not by the pipeline:

- **`iam:CreateServiceLinkedRole`**, condition-scoped to exactly `ecs.amazonaws.com`, `ecs.application-autoscaling.amazonaws.com`, and `elasticloadbalancing.amazonaws.com` (`terraform/iam.tf:531-546`) — AWS auto-creates a service-linked role the first time an account uses ECS, ELB, or ECS Service Auto Scaling; this is a narrow grant for exactly that, not a general role-creation permission.
- **`ec2:GetSecurityGroupsForVpc`** (`terraform/iam.tf:275-283`) — a newer ELBv2 `CreateLoadBalancer`-flow read action not covered by the existing `ec2:Describe*` wildcard.

This is expected, not a one-time gap: **the deployer accrues scoped permissions as new AWS resource types are introduced**. The most recent addition is [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md)'s **self-serve table grant**, tightened after infra-review to be **control-plane only**: a `DynamoDbTableLifecycleManagement` statement scoped to `arn:aws:dynamodb:<region>:<account>:table/soa-*` granting exactly the create/read/update actions Terraform's `aws_dynamodb_table` needs (`CreateTable`/`DescribeTable`/`UpdateTable`/`ListTagsOfResource`/`TagResource`/TTL + continuous-backups describe/update) — **with no data-plane actions and no `DeleteTable`**, and with the previous broad `dynamodb:*`/`*` grant removed entirely. An explicit `DenyDynamoDbTableDeletion` statement (deny `DeleteTable`/`DeleteBackup` on the same scope) remains as a backstop against a future broad grant. So the deployer can create/update a table but can never delete it *or* touch its rows (see [ADR 0003](../architecture/decisions/0003-base-edge-split.md)). The same PRD also narrowed the deployer's Terraform state access to the `app-base/`+`app-edge/` keys (excluding the human-applied `platform/` identity state). Each addition is a deliberate, human-applied, narrowly-scoped grant against `terraform/iam.tf` — never a blanket permission and never something CD applies to itself. See [terraform-foundation.md](terraform-foundation.md) and [cicd-pipeline.md §5](cicd-pipeline.md#5-operational-rules-and-gotchas) for the same pattern in earlier PRDs.

## 6. `/health` is not externally routed

Every service's target group health-checks `GET /health` (`health_check_path`, default in `modules/ecs-service/variables.tf`) — this is what ECS/the ALB use internally to decide a task is up. It is **not** the same as a listener rule: only a service's own route (e.g. `/orders*`) gets forwarded by the shared listener. Hitting `/health` from outside the ALB (with no listener rule for it) falls through to the listener's default 404, even though the task itself is healthy. Add an explicit listener rule for `/health` on a per-service basis if an externally-checkable health endpoint is ever wanted.

## 7. Cost and teardown

Per [ADR 0003](../architecture/decisions/0003-base-edge-split.md), the compute layer described in this doc now spans two configs with different lifecycles — only **`terraform/app-edge/`** is torn down between sessions to return spend to ~$0; **`terraform/app-base/`** (network, cluster, execution role, ALB SG, every table, and the frontend S3 site bucket — see [ADR 0004](../architecture/decisions/0004-frontend-hosting.md)) stays up, permanently, at $0. Only two resources in the whole compute layer are billable, and both live in `app-edge`:

- The **ALB** (~$16/mo while it exists).
- Each **Fargate task** (~$9/mo per always-on 0.25 vCPU / 0.5 GB task at 1 task minimum).

Everything else (ECS cluster, target groups, security groups, ECR repos*, DynamoDB tables, log groups, IAM roles) is free or free-tier. (*ECR repos themselves are free; they live in `app-edge`, per §4 above, so they — and any images in them — are recreated each teardown/recreate cycle, not billed while gone.) See [PRD platform/0004 §5](../action_plan/platform/0004-ecs-alb.md#5-resources) and [PRD platform/0006 §5](../action_plan/platform/0006-base-edge-split.md#5-resources) for the full resource-by-resource breakdowns.

```bash
terraform -chdir=terraform/app-edge destroy
```

removes the ALB, listener, and every service's ECS resources — task definitions, services, target groups, listener rules, task roles, autoscaling, and (per service) the ECR repo (`force_delete = true`, so leftover pushed images don't block destroy). **DynamoDB tables are not touched** — they live in `app-base`, a separate state this command never reads. Redeploying afterwards is just the next push to `main` or a local `app-edge apply`; the ECR-then-full-apply sequence in §4 handles recreating the edge from scratch every time, not just on a service's first-ever deploy. Full procedure, including how to confirm ~$0: [cost-lifecycle.md](cost-lifecycle.md).

## Related docs

- [adding-a-service.md](adding-a-service.md) — the `/new-service` and manual paths for wiring a new service onto this compute layer.
- [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md) — the binding app + infra contract every service (and the pipeline's discovery loop) relies on.
- [terraform-foundation.md](terraform-foundation.md) — the `soa-boundary` pattern, OIDC/keyless auth, and the identity foundation this layer's roles depend on.
- [cicd-pipeline.md](cicd-pipeline.md) — the workflows' triggers, auth, and operational rules in full.
- [cost-lifecycle.md](cost-lifecycle.md) — the teardown/spin-up procedure for `app-edge`.
- [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) — the plan and outcome for the cluster/ALB/modules described in this doc.
- [PRD platform/0005](../action_plan/platform/0005-service-factory.md) — the plan and outcome for generalizing the pipeline's build/push/deploy loop over `services/*`.
- [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) — the plan and outcome for the base/edge split.
- [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) / [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) / [ADR 0003](../architecture/decisions/0003-base-edge-split.md) — the decisions behind this shape.
