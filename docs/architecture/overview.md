# Architecture Overview

How the system is shaped, starting from the network every workload runs in. This grows as services land — today it covers the network foundation ([PRD platform/0003](../action_plan/platform/0003-network.md)) and the compute layer ([PRD platform/0004](../action_plan/platform/0004-ecs-alb.md)).

## Network

One VPC, spread across **two public subnets in two Availability Zones**, with no NAT gateway:

- **Single VPC** — one network per AWS account/region for this project, sized to comfortably fit the ECS/ALB workloads planned in [ADR 0001](decisions/0001-platform-and-compute-architecture.md).
- **Two public subnets, one per AZ** — gives the ALB and ECS Fargate tasks Multi-AZ placement (resilience to a single AZ outage) without needing private subnets.
- **Public-subnet, no-NAT design** — every subnet routes `0.0.0.0/0` to an internet gateway; there are no private subnets and no NAT gateway. This is a deliberate cost trade-off, not an oversight — see [ADR 0001](decisions/0001-platform-and-compute-architecture.md#decision) ("Fargate tasks in public subnets to avoid a NAT gateway"). It means workloads placed here are internet-adjacent, so **security groups (added with each workload, not with the network) carry the access control** that a private-subnet design would otherwise get for free from network isolation.
- **Internet gateway** — the sole path in/out of the VPC.

ECS services and the shared ALB (see [ADR 0001](decisions/0001-platform-and-compute-architecture.md), and Compute below) run directly in these public subnets, reachable only through security groups scoped at the resource that needs exposure (e.g. only the ALB open to the internet; tasks reachable only from the ALB).

**Concrete values (CIDR, subnet count, AZ names) live in Terraform, not here** — see [`terraform/app/modules/network/`](../../terraform/app/modules/network/) for the resource definitions and [`terraform/app/main.tf`](../../terraform/app/main.tf) for how AZs are selected. Do not restate CIDRs/AZ names in prose; they can change without this doc needing an edit.

## Compute

Synchronous microservices run as **ECS Fargate** tasks in the public subnets above, behind a **single shared Application Load Balancer** — one ALB for every service, not one each, per [ADR 0001](decisions/0001-platform-and-compute-architecture.md)'s cost posture. The ALB's one HTTP listener routes by path: each service registers its own listener rule (e.g. `/items*`); anything unmatched gets a fixed 404.

Each service gets its **own DynamoDB table(s)** — polyglot persistence, no shared database between services — and its **own IAM task role**, scoped to only its own table(s) and carrying the shared `soa-boundary`. A single **shared ECS task execution role** (image pull + log write only) is reused across every service, since that part is never service-specific. Task security groups only allow the app port in from the ALB's security group, so nothing reaches a task except through the load balancer.

This is built as a **paved-road module pattern**: a service is one `data` module block (its table) + one `ecs-service` module block (its ECR repo, task role, target group, listener rule, task definition, ECS service, autoscaling) in `terraform/app/main.tf`, on top of the shared `ecs-cluster` module (cluster + ALB, created once). The `items` service ([`services/items/`](../../services/items/)) is the reference instance proving this pattern end-to-end. See [operations/compute-layer.md](../operations/compute-layer.md) for how the cluster/roles/pipeline work, and [operations/adding-a-service.md](../operations/adding-a-service.md) for the recipe to add another service — concrete resource shapes and inputs live in [`terraform/app/modules/ecs-cluster/`](../../terraform/app/modules/ecs-cluster/), [`terraform/app/modules/ecs-service/`](../../terraform/app/modules/ecs-service/), and [`terraform/app/modules/data/`](../../terraform/app/modules/data/), not restated here.

## Where this lives in Terraform

Per [ADR 0002](decisions/0002-terraform-configuration-topology.md), both the network and the compute layer are provisioned in `terraform/app/` — the billable, pipeline-applied, routinely-`terraform destroy`ed config — not the human-applied identity foundation in `terraform/` root. The network itself is free (no NAT); the ALB and each Fargate task are the only billable resources in this config — see [PRD platform/0003](../action_plan/platform/0003-network.md) §5 and [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) §5 for the resource-by-resource cost breakdowns, and [operations/compute-layer.md](../operations/compute-layer.md) §7 for teardown.

## Related docs

- [ADR 0001 — Platform & Compute Architecture](decisions/0001-platform-and-compute-architecture.md) — why ECS/Fargate + public subnets over EKS/private networking.
- [ADR 0002 — Terraform Configuration Topology](decisions/0002-terraform-configuration-topology.md) — why the network and compute layer live in a separate, destroyable `terraform/app/` config.
- [PRD platform/0003 — Network Foundation](../action_plan/platform/0003-network.md) — the plan and outcome for the network resources described above.
- [PRD platform/0004 — ECS + ALB](../action_plan/platform/0004-ecs-alb.md) — the plan and outcome for the compute layer and golden-path modules.
- [operations/compute-layer.md](../operations/compute-layer.md) — how the cluster, ALB, IAM roles, and pipeline deploy work.
- [operations/adding-a-service.md](../operations/adding-a-service.md) — the recipe for wiring a new service onto the compute layer.
- [operations/cicd-pipeline.md](../operations/cicd-pipeline.md) — how the pipeline applies `terraform/app/`.
