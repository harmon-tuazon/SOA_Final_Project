# Compute Layer: ECS Fargate + ALB

How the shared ECS Fargate cluster and Application Load Balancer work, the two IAM roles every task carries, how the pipeline builds and deploys a service's image, and how the compute layer is torn down between sessions. Built by [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md), on top of the network foundation ([PRD platform/0003](../action_plan/platform/0003-network.md), [architecture/overview.md](../architecture/overview.md#network)). Decision context: [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) (why ECS/Fargate + a single ALB), [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) (why this lives in the destroyable `terraform/app/` config).

Module sources: [`terraform/app/modules/ecs-cluster/`](../../terraform/app/modules/ecs-cluster/), [`terraform/app/modules/ecs-service/`](../../terraform/app/modules/ecs-service/), [`terraform/app/modules/data/`](../../terraform/app/modules/data/), wired in [`terraform/app/main.tf`](../../terraform/app/main.tf).

## 1. Shared cluster + single ALB

Created once, for the whole app, by `modules/ecs-cluster/`:

- **`aws_ecs_cluster`** — the shared Fargate cluster every service's tasks run on. No per-service cluster.
- **One internet-facing ALB** (`aws_lb`), sitting in the two public subnets from the network module — a deliberate cost trade from ADR 0001 (one ALB for every service, not one each).
- **ALB security group** — inbound `:80` open to the internet (the sole public entry point), open egress to reach tasks on whatever port they listen on.
- **One HTTP `:80` listener** (`aws_lb_listener`) with a **default action of a fixed 404 response**. Each service adds its own **path-based listener rule** (`aws_lb_listener_rule`, in `modules/ecs-service/`) on top of this shared listener — the cluster module never knows which services exist.
- No HTTPS/ACM/domain yet (HTTP-only demo posture — see PRD platform/0004 §9).

A service's route is whatever `path_pattern` its listener rule matches (e.g. `items` uses `/items*` — see [`terraform/app/main.tf`](../../terraform/app/main.tf)). A path with no matching rule falls through to the listener's default 404.

## 2. Two IAM roles per task — execution vs. task role

Every ECS task carries two distinct roles, kept separate on purpose:

| Role | Created by | Scope | Carries |
| --- | --- | --- | --- |
| **Execution role** | `modules/ecs-cluster/` — **one, shared** across every service's task definition | ECR pull + CloudWatch Logs write only, nothing else | Never the app's own data-plane permissions |
| **Task role** | `modules/ecs-service/` — **one per service** | The service's own runtime permissions — DynamoDB actions scoped to exactly its own table(s) (`table_arns` input) and their `index/*` sub-resources, nothing account-wide | The app's data-plane access |

There is nothing service-specific about pulling an image or writing logs, so the execution role is reused; there is everything service-specific about what data a service's code can touch, so the task role is minted per service. See [`ecs-cluster/main.tf`](../../terraform/app/modules/ecs-cluster/main.tf) (execution role + policy) and [`ecs-service/main.tf`](../../terraform/app/modules/ecs-service/main.tf) (task role + policy).

Both roles are `soa-*` named and **must** carry `permissions_boundary = soa-boundary` — the deployer's `iam:CreateRole` is conditioned on that exact boundary (see [terraform-foundation.md](terraform-foundation.md)), so a service's `ecs-service` block that omits it fails CD's apply with `AccessDenied`. Both roles use customer-managed policies only (never AWS-managed, never inline) — the deployer's `AttachRolePolicy`/`PutRolePolicy` grants don't allow either.

## 3. Network exposure: public subnets, but not exposed

Tasks run in the same public subnets as the ALB (no NAT gateway, per ADR 0001) and get a public IP (`assign_public_ip = true`) so they can reach ECR without one. That public IP does **not** mean the task is reachable directly:

- The **task security group** allows the service's app port **only from the ALB's security group** — nothing else in the VPC, and nothing from the internet, can reach the container directly.
- Traffic path is always **internet → ALB (`:80`) → listener rule → target group → task (app port)**.

## 4. Pipeline: build, push, deploy

`cd.yml` (triggered on push to `main` touching `terraform/app/**`, `services/**`, or the workflow file itself — see [`cicd-pipeline.md`](cicd-pipeline.md)) sequences four steps to solve the chicken-and-egg between "the ECR repo doesn't exist yet" and "the task needs a real image to go healthy":

1. **Targeted apply — ECR repo only** (`terraform apply -target=module.items_service.aws_ecr_repository.this`). On the very first run this creates just the repo; on every later run it's a no-op (already in state). Nothing else in the stack is touched by this step.
2. **Build + push the image**, tagged with `$GITHUB_SHA` (never `:latest`), to the repo from step 1.
3. **Full `terraform apply -var="image_tag=$GITHUB_SHA"`** — creates the rest of the stack on first run (cluster, ALB, service, autoscaling) and, on every run, points the task definition at the newly pushed tag. Terraform registering a new task-definition revision is what triggers ECS's rolling deploy — no separate `aws ecs update-service` call is needed.
4. **`aws ecs wait services-stable`** — blocks until the new task set is healthy behind the ALB (or the old one still is, in which case the wait times out and the job fails red — a bad deploy never reports green).

See [`.github/workflows/cd.yml`](../../.github/workflows/cd.yml) for the exact commands. CI (`ci.yml`, on pull request) only builds the service's Docker image (to catch Dockerfile errors) and runs `terraform plan` — it does not push or apply.

## 5. Deployer permissions: grows with new resource types

The `soa-deployer` role (assumed by `cd.yml`) only had network/IAM-adjacent permissions before this PRD. Standing up ECS/ALB for the first time in the account surfaced two gaps that a live `terraform apply` hit and that only a human could fix, since **the pipeline cannot modify its own IAM** (ADR 0002; `soa-deployer` cannot edit its own policy). Both were added by a human `terraform apply` against the root identity config (`terraform/iam.tf`), not by the pipeline:

- **`iam:CreateServiceLinkedRole`**, condition-scoped to exactly `ecs.amazonaws.com`, `ecs.application-autoscaling.amazonaws.com`, and `elasticloadbalancing.amazonaws.com` (`terraform/iam.tf:487-502`) — AWS auto-creates a service-linked role the first time an account uses ECS, ELB, or ECS Service Auto Scaling; this is a narrow grant for exactly that, not a general role-creation permission.
- **`ec2:GetSecurityGroupsForVpc`** (`terraform/iam.tf:255-265`) — a newer ELBv2 `CreateLoadBalancer`-flow read action not covered by the existing `ec2:Describe*` wildcard.

This is expected, not a one-time gap: **the deployer accrues scoped permissions as new AWS resource types are introduced** (this PRD added ECS/ELB coverage; a future SQS/Lambda PRD will likely add its own). Each addition is a deliberate, human-applied, narrowly-scoped grant against `terraform/iam.tf` — never a blanket permission and never something CD applies to itself. See [terraform-foundation.md](terraform-foundation.md) and [cicd-pipeline.md §5](cicd-pipeline.md#5-operational-rules-and-gotchas) for the same pattern in earlier PRDs.

## 6. `/health` is not externally routed

Every service's target group health-checks `GET /health` (`health_check_path`, default in `modules/ecs-service/variables.tf`) — this is what ECS/the ALB use internally to decide a task is up. It is **not** the same as a listener rule: only a service's own route (e.g. `/items*`) gets forwarded by the shared listener. Hitting `/health` from outside the ALB (with no listener rule for it) falls through to the listener's default 404, even though the task itself is healthy. Add an explicit listener rule for `/health` on a per-service basis if an externally-checkable health endpoint is ever wanted.

## 7. Cost and teardown

`terraform/app/` (network + this compute layer) is the config torn down between sessions to return spend to ~$0 — see [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) for why it's split from the permanent identity foundation. Only two resources here are billable while the stack is up:

- The **ALB** (~$16/mo while it exists).
- Each **Fargate task** (~$9/mo per always-on 0.25 vCPU / 0.5 GB task at 1 task minimum).

Everything else (ECS cluster, target groups, security groups, ECR repos, DynamoDB tables, log groups, IAM roles) is free or free-tier. See [PRD platform/0004 §5](../action_plan/platform/0004-ecs-alb.md#5-resources) for the full resource-by-resource breakdown.

```bash
terraform -chdir=terraform/app destroy
```

removes the cluster, ALB, every service's ECS resources, and (per service) the ECR repo (`force_delete = true`, so leftover pushed images don't block destroy) and DynamoDB table. Redeploying afterwards is just the next push to `main` — the first-run ECR-then-full-apply sequence in §4 handles recreating everything from scratch.

## Related docs

- [adding-a-service.md](adding-a-service.md) — the manual recipe for wiring a new service onto this compute layer.
- [terraform-foundation.md](terraform-foundation.md) — the `soa-boundary` pattern, OIDC/keyless auth, and the identity foundation this layer's roles depend on.
- [cicd-pipeline.md](cicd-pipeline.md) — the workflows' triggers, auth, and operational rules in full.
- [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) — the plan and outcome for everything in this doc.
- [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) / [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) — the decisions behind this shape.
