# Action Plan (PRDs)

Plans of record, approved before executing substantial work. Governed by [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md). Start every PRD from [`_template.md`](_template.md).

PRDs are organized **per microservice** (folder matching the service under `services/`), plus a `platform/` folder for cross-cutting infrastructure, pipeline, and teardown work. Numbering is per-folder (`0001…`).

## Index

### platform/
| PRD | Status |
| --- | --- |
| [0001 — Terraform Foundation](platform/0001-terraform-foundation.md) | Done |
| [0002 — CI/CD Pipeline (Infrastructure)](platform/0002-cicd-pipeline.md) | Done |
| [0003 — Network Foundation (terraform/app VPC)](platform/0003-network.md) | Done |
| [0004 — ECS + ALB (compute + golden-path modules)](platform/0004-ecs-alb.md) | Done |
| [0005 — Service Factory (template + contract + /new-service)](platform/0005-service-factory.md) | Done |
| [0006 — Base/Edge Split (permanent free base + destroyable edge)](platform/0006-base-edge-split.md) | Done |

### frontend/
| PRD | Status |
| --- | --- |
| [0001 — React SPA Scaffold + S3 Static Hosting](frontend/0001-spa-scaffold-and-hosting.md) | In Progress |
