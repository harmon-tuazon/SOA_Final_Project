# Action Plan (PRDs)

Plans of record, approved before executing substantial work. Governed by [`.claude/rules/action-plan.md`](../../.claude/rules/action-plan.md). Start every PRD from [`_template.md`](_template.md).

PRDs are organized **per microservice** (folder matching the service under `services/`), plus a `platform/` folder for cross-cutting infrastructure, pipeline, and teardown work. Numbering is per-folder (`0001…`).

## Index

### platform/
| PRD | Status |
| --- | --- |
| [0001 — Terraform Foundation](platform/0001-terraform-foundation.md) | Done |
| [0002 — CI/CD Pipeline (Infrastructure)](platform/0002-cicd-pipeline.md) | In Progress |
