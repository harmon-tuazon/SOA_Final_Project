# Documentation

Index of all project documentation. Structure and conventions are governed by [`.claude/rules/documentation.md`](../.claude/rules/documentation.md).

## Taxonomy

| Folder | Holds |
| --- | --- |
| [architecture/](architecture/) | How the system is shaped and what it does — component responsibilities, service interactions, data/request flows, requirements, and NFRs. Immutable ADRs live in [architecture/decisions/](architecture/decisions/). |
| [action_plan/](action_plan/) | PRDs — plans of record approved before executing substantial work, organized per microservice plus a `platform/` folder. |
| [operations/](operations/) | Everything about running the system — local setup, CI/CD pipeline, AWS setup, and operational procedures (deploy, rollback, scale, teardown, cost check). |

## Top-level docs

- [operations/terraform-foundation.md](operations/terraform-foundation.md) — S3 remote-state bootstrap, root config init/plan/apply, GitHub OIDC keyless deploy auth, and the `soa-boundary` permissions-boundary pattern.
