# Operations

Everything about running the system: local setup, the CI/CD pipeline, AWS account setup, and step-by-step operational procedures.

- **What goes here:** local dev (Docker Compose), running tests, the CI/CD pipeline stages, GitHub OIDC → AWS setup, ECS/ECR config, branch gating, and runbooks (teardown, secret rotation, scale/stop, cost check).

## Documents

- [terraform-foundation.md](terraform-foundation.md) — bootstrapping the S3 remote-state backend, init/plan/apply for the root config, the GitHub OIDC keyless-auth model, the `soa-boundary` permissions-boundary pattern, and teardown. Covers [PRD platform/0001](../action_plan/platform/0001-terraform-foundation.md).
- [cicd-pipeline.md](cicd-pipeline.md) — the `ci.yml`/`cd.yml` GitHub Actions workflows, the `soa-ci-plan` read-only role, the four Actions variables, the developer PR → merge → apply flow (now applying `app-base` then `app-edge`), and operational gotchas (deployer self-edit denies, do-not-destroy-the-foundation rule). Covers [PRD platform/0002](../action_plan/platform/0002-cicd-pipeline.md).
- [compute-layer.md](compute-layer.md) — the shared ECS Fargate cluster + single ALB, the execution-role/task-role split, how CD discovers and builds/pushes/deploys each service's image (0..N, generalized), and the deployer permissions added for ECS/ELB and self-serve tables. Covers [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) and [PRD platform/0005](../action_plan/platform/0005-service-factory.md).
- [adding-a-service.md](adding-a-service.md) — wiring a new service onto the compute layer: the service contract, the `/new-service` command and the manual `data` (in `app-base`) + `ecs-service` (in `app-edge`) Terraform blocks, and the PR → CI → CD flow, using [`services/_template/`](../../services/_template/) as the worked skeleton.
- [cost-lifecycle.md](cost-lifecycle.md) — the teardown/spin-up runbook: how to bring `app-base` up once, tear `app-edge` down to ~$0 between sessions, and spin it back up with every service's data intact. Covers [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md).
