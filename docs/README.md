# Documentation

Index of all project documentation. Structure and conventions are governed by [`.claude/rules/documentation.md`](../.claude/rules/documentation.md).

## Taxonomy

| Folder | Holds |
| --- | --- |
| [architecture/](architecture/) | How the system is shaped and what it does — component responsibilities, service interactions, data/request flows, requirements, and NFRs. Immutable ADRs live in [architecture/decisions/](architecture/decisions/). |
| [action_plan/](action_plan/) | PRDs — plans of record approved before executing substantial work, organized per microservice plus a `platform/` folder. |
| [operations/](operations/) | Everything about running the system — local setup, CI/CD pipeline, AWS setup, and operational procedures (deploy, rollback, scale, teardown, cost check). |

## Top-level docs

- [architecture/overview.md](architecture/overview.md) — system shape: the network foundation (VPC, public subnets, no-NAT design), the compute layer (ECS Fargate + shared ALB, per-service DynamoDB, the paved-road module pattern), the `app-base`/`app-edge` split, and the no-hardcoded-endpoint convention.
- [architecture/decisions/0003-base-edge-split.md](architecture/decisions/0003-base-edge-split.md) — ADR: why the billable app tier is split into a permanent, free `app-base` and a destroyable, billable `app-edge`, with self-serve DynamoDB tables protected by a `DeleteTable` deny.
- [operations/terraform-foundation.md](operations/terraform-foundation.md) — S3 remote-state bootstrap, root config init/plan/apply, GitHub OIDC keyless deploy auth, and the `soa-boundary` permissions-boundary pattern.
- [operations/cicd-pipeline.md](operations/cicd-pipeline.md) — the `ci.yml`/`cd.yml` GitHub Actions workflows (targeting `app-base`/`app-edge`), the `soa-ci-plan` read-only role, Actions variables, developer flow, and operational rules (deployer self-edit denies, do-not-destroy-the-foundation).
- [operations/compute-layer.md](operations/compute-layer.md) — the shared ECS Fargate cluster + ALB, execution-role vs. task-role split, how CD builds/pushes/deploys images, deployer permissions added for ECS/ELB and self-serve tables.
- [operations/adding-a-service.md](operations/adding-a-service.md) — the golden-path recipe for wiring a new service onto the compute layer (a table block in `app-base`, a service block in `app-edge`), via the `/new-service` command or manually from `services/_template/`.
- [operations/cost-lifecycle.md](operations/cost-lifecycle.md) — the teardown/spin-up runbook: how `app-edge` is destroyed to ~$0 between sessions while `app-base` (and every service's data) stays standing.
