# Architecture Overview

How the system is shaped, starting from the network every workload runs in. This grows as services land — today it covers only the network foundation built by [PRD platform/0003](../action_plan/platform/0003-network.md).

## Network

One VPC, spread across **two public subnets in two Availability Zones**, with no NAT gateway:

- **Single VPC** — one network per AWS account/region for this project, sized to comfortably fit the ECS/ALB workloads planned in [ADR 0001](decisions/0001-platform-and-compute-architecture.md).
- **Two public subnets, one per AZ** — gives the ALB and ECS Fargate tasks Multi-AZ placement (resilience to a single AZ outage) without needing private subnets.
- **Public-subnet, no-NAT design** — every subnet routes `0.0.0.0/0` to an internet gateway; there are no private subnets and no NAT gateway. This is a deliberate cost trade-off, not an oversight — see [ADR 0001](decisions/0001-platform-and-compute-architecture.md#decision) ("Fargate tasks in public subnets to avoid a NAT gateway"). It means workloads placed here are internet-adjacent, so **security groups (added with each workload, not with the network) carry the access control** that a private-subnet design would otherwise get for free from network isolation.
- **Internet gateway** — the sole path in/out of the VPC.

Future ECS services and the shared ALB (see [ADR 0001](decisions/0001-platform-and-compute-architecture.md)) run directly in these public subnets, reachable only through security groups scoped at the resource that needs exposure (e.g. only the ALB open to the internet; tasks reachable only from the ALB) — not yet built, tracked as an open item in PRD platform/0003 §9.

**Concrete values (CIDR, subnet count, AZ names) live in Terraform, not here** — see [`terraform/app/modules/network/`](../../terraform/app/modules/network/) for the resource definitions and [`terraform/app/main.tf`](../../terraform/app/main.tf) for how AZs are selected. Do not restate CIDRs/AZ names in prose; they can change without this doc needing an edit.

## Where this lives in Terraform

Per [ADR 0002](decisions/0002-terraform-configuration-topology.md), the network is provisioned in `terraform/app/` — the billable, pipeline-applied, routinely-`terraform destroy`ed config — not the human-applied identity foundation in `terraform/` root. It is currently free (no NAT, no ALB, no compute yet); see [PRD platform/0003](../action_plan/platform/0003-network.md) §5 for the resource-by-resource cost breakdown.

## Related docs

- [ADR 0001 — Platform & Compute Architecture](decisions/0001-platform-and-compute-architecture.md) — why ECS/Fargate + public subnets over EKS/private networking.
- [ADR 0002 — Terraform Configuration Topology](decisions/0002-terraform-configuration-topology.md) — why the network lives in a separate, destroyable `terraform/app/` config.
- [PRD platform/0003 — Network Foundation](../action_plan/platform/0003-network.md) — the plan and outcome for the resources described above.
- [operations/cicd-pipeline.md](../operations/cicd-pipeline.md) — how the pipeline applies `terraform/app/`.
