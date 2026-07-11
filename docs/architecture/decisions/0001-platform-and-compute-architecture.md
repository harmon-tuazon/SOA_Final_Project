# 0001 — Platform & Compute Architecture

> The system runs on AWS as a hybrid of ECS Fargate (sync microservices) and Lambda+SQS (async workers), chosen for lowest cost while preserving the containers-and-orchestration learning goals.

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

This is an SOA / microservices course project. Two forces dominate every decision:

1. **Cost.** The project must run on a personal AWS free account (plus any student credits) without a nasty bill. There is no hard spending cap by default, so the design has to be cheap by construction and fully destroyable.
2. **The rubric.** Points are awarded for containerization (Docker), orchestration, service discovery/scaling, message-queue communication, testing, and CI/CD.

The original brief targeted local Kubernetes; we moved to AWS. Managed Kubernetes (EKS) was evaluated and rejected on cost: the control plane alone is ~$73/mo flat, and a realistic idle stack (nodes + NAT + ALB) is ~$120–150/mo — untenable for a ~2-month project on free-tier/credits.

Pure serverless (Lambda + API Gateway + DynamoDB) is essentially $0 on always-free tiers, but demonstrates **neither containers nor orchestration** — forfeiting roughly half the technical rubric.

## Decision

Adopt a **hybrid AWS architecture**:

- **Frontend:** React SPA served as **S3 static content**.
- **Auth:** **Amazon Cognito** (user pool).
- **Synchronous microservices:** **ECS Fargate** services (e.g. User, Product, Order) behind a single **Application Load Balancer (ALB)**.
- **Asynchronous work:** an ECS service publishes to **SQS**; a **Lambda** worker consumes it and fans out via **SNS** (notifications/email). Decoupled — sync services never block on async work.
- **Data:** **DynamoDB**, a separate table set per service (polyglot persistence, scales to zero).
- **Secrets/config:** **SSM Parameter Store** (free) over Secrets Manager.
- **Registry:** **Amazon ECR** for container images (SHA-tagged).
- **IaC state:** **S3 bucket with native locking** (`use_lockfile`, Terraform ≥ 1.10).
- **CI/CD:** GitHub Actions, keyless **GitHub OIDC → AWS IAM**.

**Cost posture (binding):** Fargate tasks in **public subnets to avoid a NAT gateway**, a **single shared ALB**, DynamoDB + SSM on free tiers, a budget alarm, and **`terraform destroy` between sessions**. Only ECS + ALB incur real cost (~$5–15/mo active, ~$0 when destroyed); the async branch (SQS/Lambda/SNS) is effectively free.

## Consequences

- **Easier:** stays inside a free account with disciplined teardown; keeps the container + orchestration + message-queue story the rubric rewards; async is free to add.
- **Harder / accepted trade-offs:**
  - Two compute models to build and ship (container images for ECS, packages for Lambda) — the repo splits into `services/` (ECS) and `functions/` (Lambda), and the pipeline has two build paths.
  - ALB is not free-tier and bills while it exists — mitigated by destroy-between-sessions.
  - ECS services need internet egress for image pulls / AWS API calls; using public subnets (no NAT) is a deliberate cost trade that must be paired with tight security groups.

## Open risk

- **Rubric wording.** The grading rubric literally says **"Kubernetes Deployment."** ECS satisfies the *concepts* (containers, orchestration, service auto-scaling ≈ HPA, Cloud Map/Service Connect discovery, per-task IAM) but is **not Kubernetes**. A strict grader could dock the Kubernetes-specific points. **Action:** confirm with the instructor that ECS-over-EKS is acceptable, or that the requirements may be adapted. Tracked as an open item until confirmed.

## Alternatives considered

- **Amazon EKS (managed Kubernetes)** — literal rubric match, but ~$120–150/mo idle. Rejected on cost.
- **Self-managed Kubernetes (k3s/kind on one EC2)** — cheap and still Kubernetes, but ops overhead and a single point of failure; less representative of managed cloud practice. Held as a fallback if the instructor requires literal Kubernetes.
- **Pure serverless (Lambda + API Gateway + DynamoDB)** — ~$0, but demonstrates no containers/orchestration; forfeits ~half the rubric. Adopted only for the async branch.
