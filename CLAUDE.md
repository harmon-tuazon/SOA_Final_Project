# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repository is being built from scratch. As of now there is no application code — the authoritative source is [PROJECT REQUIREMENTS.md](PROJECT%20REQUIREMENTS.md), and the platform/compute decision is recorded in [ADR 0001](docs/architecture/decisions/0001-platform-and-compute-architecture.md) and the Terraform configuration topology in [ADR 0002](docs/architecture/decisions/0002-terraform-configuration-topology.md). The distilled, working specs live under [docs/](docs/) as they are written. Everything below is the **target** state being built toward, not yet-existing code; verify a path/command exists before relying on it.

## What this is

A **microservices application on AWS**, built for an SOA course project as a **hybrid of containers and event-driven serverless**:

- **Synchronous microservices** run as Docker containers on **Amazon ECS (Fargate)** behind a single **Application Load Balancer (ALB)**.
- **Asynchronous / decoupled work** runs on **AWS Lambda**, triggered through **Amazon SQS**, fanning out via **SNS** (e.g. notifications/email).

Container images are published to **Amazon ECR**; all cloud infrastructure is provisioned with **Terraform**; the build/test/deploy flow runs through **GitHub Actions**. The concrete set of services lives in the specs under `docs/` — this file describes the **framework and conventions**, not the application's business rules.

Two constraints shape decisions (see ADR 0001):
- **Stay cheap and disposable.** Only ECS + ALB cost real money; the async branch (SQS/Lambda/SNS), DynamoDB, and SSM are free-tier. Public subnets avoid a NAT gateway, a single shared ALB is used, and `terraform destroy` returns spend to ~$0 between sessions.
- **Least-privilege posture.** Separate, scoped IAM identities for the pipeline vs. the running workloads; no long-lived cloud credentials in the repo.

## Target repository layout

```
SOA_Final_Project/
├── .github/workflows/
│   ├── ci.yml          # lint, test, terraform validate/plan, docker build — runs on PRs
│   └── cd.yml          # build+push to ECR, package Lambdas, terraform apply, deploy — on push to main
├── services/           # ECS Fargate microservices (one folder each: source + Dockerfile + tests)
│   ├── <service-a>/
│   └── <service-b>/
├── functions/          # Lambda functions (one folder each: handler + tests)
│   └── <worker>/
├── ecs/                # ECS task/service definitions
├── docker-compose.yml  # local multi-service dev / testing
├── terraform/          # THREE separate configs/states — see ADR 0002
│   ├── bootstrap/      #   state-bucket config — applied once by hand, never destroyed
│   ├── *.tf            #   ROOT = identity foundation (permanent, human-applied):
│   │                   #   GitHub OIDC provider, soa-deployer + soa-ci-plan roles, soa-boundary
│   └── app/            #   billable app infra (own state) — pipeline-applied, destroyable:
│       ├── main.tf     #     wires modules; own backend.tf (separate state key)
│       └── modules/    #     network, ecs, lambda, messaging(SQS/SNS), registry(ECR),
│                       #     data(DynamoDB), observability(CloudWatch)
├── docs/               # structured documentation (see Documentation below)
│   ├── architecture/   # shape, requirements & NFRs; ADRs in architecture/decisions/
│   ├── action_plan/    # PRDs (see action-plan rule)
│   └── operations/     # local setup, CI/CD, AWS setup, ops procedures
└── README.md
```

## Architecture (big picture)

Three zones: **GitHub** (code + CI/CD), the **AWS account** (all runtime resources), and **external actors/services** (users, and third-party integrations).

- **Frontend:** a React SPA served as **S3 static content**. **Auth:** Amazon Cognito.
- **Sync compute:** ECS Fargate services behind an **ALB**. ECS handles service discovery (**Service Connect / Cloud Map**), scaling (**Service Auto Scaling**), and rolling deployments.
- **Async compute:** an ECS service publishes to **SQS**; a **Lambda** worker consumes it and fans out via **SNS**. Sync services never block on async work.
- **Images:** Amazon ECR (one repo per service or shared). **Images are tagged by git commit SHA** — never deploy `:latest`.
- **Data:** **DynamoDB**, a separate table set per service — polyglot persistence, no shared database between services, scales to zero.
- **Secrets & config:** services read all config/secrets from the environment, sourced from **SSM Parameter Store** (free) / Secrets Manager — never from source, the image, or committed env files.
- **Identity:** separate least-privilege IAM roles for the pipeline vs. each workload (per-service **ECS task roles**, Lambda execution roles). Compromise of one does not grant another's access.
- **Observability:** Amazon CloudWatch metrics/alarms and CloudWatch Logs; a cost budget/alert to guard spend.

Pick a single AWS region and keep all resources in it to keep inter-service transfer free; the region is a one-variable change in Terraform. ECS tasks run in **public subnets (no NAT gateway)** with tight security groups — a deliberate cost trade.

## Infrastructure: Terraform

Everything is provisioned through Terraform — nothing is clicked together in the console. Terraform is split into **three separate configs, each with its own state, by lifecycle** (see [ADR 0002](docs/architecture/decisions/0002-terraform-configuration-topology.md)):

- **`terraform/bootstrap/`** — the remote-state S3 bucket. Applied once by hand; **never destroyed**.
- **`terraform/` (root) — the identity foundation** (GitHub OIDC provider, `soa-deployer` + `soa-ci-plan` roles, `soa-boundary`). **Free and permanent**, and **human-applied** — the deployer can't modify its own IAM, so identity changes need a local `terraform apply` with admin creds. **Not** part of routine teardown.
- **`terraform/app/` — the billable app infra** (VPC, ECS, ALB, ECR, DynamoDB, SQS/SNS, Lambda, CloudWatch, and per-service workload roles). Applied by the **pipeline** (`cd.yml`) and split into small single-purpose modules under `terraform/app/modules/`. **This is the config `terraform destroy`ed between sessions** to return spend to ~$0.

- **Remote state** for each config lives in the shared **versioned S3 bucket** (distinct keys) with **native state locking** (`use_lockfile = true`, Terraform ≥ 1.10; `backend.tf`). Locking prevents concurrent runs from corrupting state; versioning lets you roll back a bad apply.
- Common commands: `terraform init`, `terraform fmt`, `terraform validate`, `terraform plan`, `terraform apply`, run from the relevant config dir. **`terraform destroy` targets `terraform/app/`** — tearing down billable infra between sessions is expected; the identity foundation and state bucket are deliberately left standing.

## CI/CD: GitHub Actions

Two workflows, gated by branch:

- **`ci.yml` (on pull request)** — must pass before merge: per-service lint + tests (unit + integration), Docker build (services) / package (functions), and `terraform fmt`/`validate`/`plan` on **`terraform/app/`** (keyless OIDC as the read-only `soa-ci-plan` role).
- **`cd.yml` (on push to `main`)** — authenticate to AWS (keyless OIDC as `soa-deployer`) → build each service image tagged with `$GITHUB_SHA` → push to ECR → package Lambda functions → `terraform apply` on **`terraform/app/`** → deploy services to ECS (`aws ecs update-service` / new task definition) and publish new Lambda versions → smoke-test → complete the rollout. (The identity foundation in `terraform/` root is human-applied, not touched by the pipeline.)

**Deployment strategy (rolling / built-in rollback):** ECS performs a rolling update (new task set brought up and health-checked behind the ALB before the old one drains); a failed health check stops the rollout on the last good task definition. Because images are SHA-tagged, rollback is a redeploy of the previous known-good task definition.

**Keyless auth (GitHub OIDC → AWS IAM):** the pipeline stores **no long-lived AWS keys**. GitHub issues a short-lived OIDC token per run; an AWS IAM role trusts that token and is assumed for a few minutes (`AssumeRoleWithWebIdentity`). Only **non-sensitive identifiers** (role ARN, region, account/registry, cluster/service names) are stored as GitHub Actions *variables*. Do not introduce long-lived IAM user access keys into repo secrets — that is the exact risk this design eliminates.

## Application stack

Container-first microservices and event-driven functions:

- **`services/` (ECS Fargate):** each service reads all config/secrets from the environment, connects only to its own DynamoDB tables, and exposes a RESTful API. Independently buildable, testable, deployable; ships a Dockerfile (small, multi-stage, non-root, health endpoint).
- **`functions/` (Lambda):** event-driven workers (e.g. SQS-triggered). Small, single-purpose handlers; no HTTP server.

Language and framework per service follow the specs/ADRs under `docs/` — keep each unit small, single-purpose, and cloud-native. Every behavioural change ships with tests (unit / integration / e2e). Delegate application work to the `app-engineer` agent.

**The golden path.** New services are scaffolded from `services/_template/` — usually via the **`/new-service`** command ([`.claude/commands/new-service.md`](.claude/commands/new-service.md)), which interviews the developer, generates a per-service PRD, and (on approval) scaffolds the app **plus** its `data`/`ecs-service` Terraform blocks. Every service must follow the binding **[`.claude/rules/service-contract.md`](.claude/rules/service-contract.md)** (config from env, `/health`, own DynamoDB table, boundary-scoped task role, standard naming). The CI/CD pipeline auto-discovers services under `services/*` (skipping `_template`).

**Build the app to its spec, not from scratch.** The services, APIs, data model, and behaviour follow the specs under `docs/architecture/` (derived from [PROJECT REQUIREMENTS.md](PROJECT%20REQUIREMENTS.md)).

## Documentation

All project documentation lives under `docs/` with a fixed taxonomy (architecture / action_plan / operations). The full rule is in [`.claude/rules/documentation.md`](.claude/rules/documentation.md) — read it before writing docs. Update docs in the same change that alters behaviour; record significant decisions as ADRs under `docs/architecture/decisions/`. Delegate documentation creation, restructuring, and audits to the `documentation-keeper` agent.

Substantial work (provisioning resources, standing up a pipeline stage, scaffolding a service, teardown) gets an **approved PRD** under `docs/action_plan/` **before execution** — see [`.claude/rules/action-plan.md`](.claude/rules/action-plan.md).

## Conventions & guardrails

- Keep the environment **cheap and disposable.** No always-on resources without a design reason (no NAT gateway, no idle load balancers beyond the single shared ALB, no oversized tasks); prefer free-tier services and tear down **`terraform/app/`** with `terraform destroy` when idle (the identity foundation and state bucket stay standing — see ADR 0002).
- Keep **databases private** (not publicly exposed) and keep **pipeline and workload IAM identities separate and least-privilege**.
- Tag images by commit SHA; never deploy `:latest`.
