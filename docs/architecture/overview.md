# Architecture Overview

How the system is shaped, starting from the network every workload runs in. This grows as services land — today it covers the network foundation ([PRD platform/0003](../action_plan/platform/0003-network.md)), the compute layer ([PRD platform/0004](../action_plan/platform/0004-ecs-alb.md)), and the permanent/destroyable split described below ([PRD platform/0006](../action_plan/platform/0006-base-edge-split.md), [ADR 0003](decisions/0003-base-edge-split.md)).

## Network

One VPC, spread across **two public subnets in two Availability Zones**, with no NAT gateway:

- **Single VPC** — one network per AWS account/region for this project, sized to comfortably fit the ECS/ALB workloads planned in [ADR 0001](decisions/0001-platform-and-compute-architecture.md).
- **Two public subnets, one per AZ** — gives the ALB and ECS Fargate tasks Multi-AZ placement (resilience to a single AZ outage) without needing private subnets.
- **Public-subnet, no-NAT design** — every subnet routes `0.0.0.0/0` to an internet gateway; there are no private subnets and no NAT gateway. This is a deliberate cost trade-off, not an oversight — see [ADR 0001](decisions/0001-platform-and-compute-architecture.md#decision) ("Fargate tasks in public subnets to avoid a NAT gateway"). It means workloads placed here are internet-adjacent, so **security groups (added with each workload, not with the network) carry the access control** that a private-subnet design would otherwise get for free from network isolation.
- **Internet gateway** — the sole path in/out of the VPC.

ECS services and the shared ALB (see [ADR 0001](decisions/0001-platform-and-compute-architecture.md), and Compute below) run directly in these public subnets, reachable only through security groups scoped at the resource that needs exposure (e.g. only the ALB open to the internet; tasks reachable only from the ALB).

**Concrete values (CIDR, subnet count, AZ names) live in Terraform, not here** — see [`terraform/modules/network/`](../../terraform/modules/network/) for the resource definitions and [`terraform/app-base/main.tf`](../../terraform/app-base/main.tf) for how AZs are selected. Do not restate CIDRs/AZ names in prose; they can change without this doc needing an edit.

## Compute

Synchronous microservices run as **ECS Fargate** tasks in the public subnets above, behind a **single shared Application Load Balancer** — one ALB for every service, not one each, per [ADR 0001](decisions/0001-platform-and-compute-architecture.md)'s cost posture. The ALB's one HTTP listener routes by path: each service registers its own listener rule (e.g. `/orders*`); anything unmatched gets a fixed 404.

Each service gets its **own DynamoDB table(s)** — polyglot persistence, no shared database between services — and its **own IAM task role**, scoped to only its own table(s) and carrying the shared `soa-boundary`. A single **shared ECS task execution role** (image pull + log write only) is reused across every service, since that part is never service-specific. Task security groups only allow the app port in from the ALB's security group, so nothing reaches a task except through the load balancer.

This is built as a **paved-road module pattern**: a service is one `data` module block (its table) + one `ecs-service` module block (its ECR repo, task role, target group, listener rule, task definition, ECS service, autoscaling), on top of the shared `ecs-cluster` module (cluster + execution role + ALB security group) and `alb` module (the ALB + listener itself). As of [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) / [ADR 0003](decisions/0003-base-edge-split.md), the two module blocks for a given service **do not live in the same config** — see "Where this lives in Terraform" below. The `order` service ([`services/order/`](../../services/order/)) is the first real instance of this pattern — its application half is built ([PRD order/0001](../action_plan/order/0001-service-scaffold.md)); its two Terraform blocks are specified in that PRD §5.1 and are pending, so the pattern is not yet proven end-to-end on the cluster. See [operations/compute-layer.md](../operations/compute-layer.md) for how the cluster/roles/pipeline work, and [operations/adding-a-service.md](../operations/adding-a-service.md) for the recipe to add another service — concrete resource shapes and inputs live in [`terraform/modules/ecs-cluster/`](../../terraform/modules/ecs-cluster/), [`terraform/modules/alb/`](../../terraform/modules/alb/), [`terraform/modules/ecs-service/`](../../terraform/modules/ecs-service/), and [`terraform/modules/data/`](../../terraform/modules/data/), not restated here.

## Frontend

The demo React SPA ([`frontend/`](../../frontend/)) — a Part 4 "showcase" asset, beyond the graded backend rubric — is hosted as an **S3 static website over plain HTTP**, per [ADR 0004](decisions/0004-frontend-hosting.md). It is provisioned by [`terraform/modules/frontend/`](../../terraform/modules/frontend/), wired into **`app-base`** (not `app-edge`) — permanent and free, so it stays reachable across every routine `app-edge` teardown/spin-up cycle; only its backend API calls degrade gracefully while the edge is down.

The SPA never hardcodes the backend's API URL. It fetches a runtime `/config.json` object once at startup (`src/lib/config.ts`, awaited before render in `src/main.tsx`); backend `cd.yml` rewrites that file on S3 with the live ALB DNS after every `app-edge` apply, and `frontend-cd.yml` (the frontend's own build+deploy workflow) excludes `config.json` from its sync so a frontend-only deploy never clobbers the live URL. See [ADR 0004](decisions/0004-frontend-hosting.md) for the full reasoning, and [operations/adding-a-frontend-feature.md](../operations/adding-a-frontend-feature.md) for how a page/feature is added.

HTTPS (CloudFront + a custom domain) and real Cognito auth are **deferred** to one later, coherent PRD — an HTTPS-served page cannot call today's HTTP-only ALB (mixed content), and Cognito's hosted UI requires HTTPS redirect URIs. Only an auth stub (`src/auth/AuthContext.tsx`, `src/auth/ProtectedRoute.tsx`) is scaffolded for now.

## No hardcoded endpoints (project-wide convention)

Because the ALB is recreated on every teardown/spin-up cycle (see "Where this lives in Terraform" below), its DNS name is not stable across sessions. Every consumer — the React frontend (see Frontend above), and any service-to-service call — **reads the API base URL from config/env, never a literal ALB DNS name, IP, or endpoint in source**. This is a binding rule in [`service-contract.md`](../../.claude/rules/service-contract.md)'s application contract, enforced by a CI-visible grep for `elb.amazonaws.com` in `services/`/`functions/` (and, for the frontend, `frontend/src/`). It also makes a future stable domain (Route 53 custom domain, deferred — see [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) §3 out-of-scope) a one-value config change rather than a source change once it lands.

## Where this lives in Terraform

Per [ADR 0002](decisions/0002-terraform-configuration-topology.md) and refined by [ADR 0003](decisions/0003-base-edge-split.md), the network and compute layer are now split across **two** billable, pipeline-applied configs by lifecycle — not the single `terraform/app/` config ADR 0002 originally described (retired):

- **`terraform/app-base/`** — the network, the ECS cluster, the shared execution role, the ALB security group, and **every service's DynamoDB table**. Free, permanent, never destroyed.
- **`terraform/app-edge/`** — the ALB + HTTP listener, and every service's `ecs-service` module (compute). Destroyable, billable (~$16/mo ALB + Fargate task cost while running); this is what routine `terraform destroy` targets.

Neither config is the human-applied identity foundation in `terraform/` root. See [PRD platform/0003](../action_plan/platform/0003-network.md) §5 and [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) §5 for the original resource-by-resource cost breakdowns, [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) §5 for the split's cost table, and [operations/cost-lifecycle.md](../operations/cost-lifecycle.md) for the teardown/spin-up procedure.

## Related docs

- [ADR 0001 — Platform & Compute Architecture](decisions/0001-platform-and-compute-architecture.md) — why ECS/Fargate + public subnets over EKS/private networking.
- [ADR 0002 — Terraform Configuration Topology](decisions/0002-terraform-configuration-topology.md) — why the network and compute layer live in a separate, destroyable config, apart from the identity foundation.
- [ADR 0003 — Base/Edge Split](decisions/0003-base-edge-split.md) — why that billable config is itself split into a permanent `app-base` and a destroyable `app-edge`.
- [ADR 0004 — Frontend Hosting](decisions/0004-frontend-hosting.md) — why the SPA is S3-hosted over HTTP with a runtime `config.json`, and why HTTPS/auth are deferred.
- [PRD platform/0003 — Network Foundation](../action_plan/platform/0003-network.md) — the plan and outcome for the network resources described above.
- [PRD platform/0004 — ECS + ALB](../action_plan/platform/0004-ecs-alb.md) — the plan and outcome for the compute layer and golden-path modules.
- [PRD platform/0006 — Base/Edge Split](../action_plan/platform/0006-base-edge-split.md) — the plan and outcome for the base/edge split.
- [PRD frontend/0001 — SPA Scaffold + S3 Hosting](../action_plan/frontend/0001-spa-scaffold-and-hosting.md) — the plan and outcome for the frontend described above.
- [operations/compute-layer.md](../operations/compute-layer.md) — how the cluster, ALB, IAM roles, and pipeline deploy work.
- [operations/adding-a-service.md](../operations/adding-a-service.md) — the recipe for wiring a new service onto the compute layer.
- [operations/adding-a-frontend-feature.md](../operations/adding-a-frontend-feature.md) — the recipe for adding a page/feature to the SPA.
- [operations/cicd-pipeline.md](../operations/cicd-pipeline.md) — how the pipeline applies `app-base` and `app-edge`.
- [operations/cost-lifecycle.md](../operations/cost-lifecycle.md) — the teardown/spin-up procedure.
