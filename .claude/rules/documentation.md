# Documentation Rule

All project documentation lives under `docs/` and follows a fixed taxonomy. Keep docs close to the work and update them in the same change that alters behaviour — documentation drift is a bug.

## Taxonomy — where things go

| Folder | Holds | Examples |
| --- | --- | --- |
| `docs/architecture/` | How the system is shaped and what it does; component responsibilities, service interactions, data/request flows, and the requirements (functional + NFRs) it meets. Immutable ADRs live in `docs/architecture/decisions/`. | `overview.md`, service-interaction diagrams, use cases, NFRs, `decisions/0001-platform-and-tooling.md` |
| `docs/action_plan/` | PRDs — plans of record written and approved *before* executing substantial work, **organized per microservice** (plus a `platform/` folder for cross-cutting infra). Governed by [`action-plan.md`](action-plan.md) (structure, numbering, approval gate). Written by the main session, which assigns the agents. | `platform/0001-terraform-foundation.md`, `<service>/0001-service-scaffold.md` |
| `docs/operations/` | Everything about running the system — local setup, CI/CD pipeline, AWS account setup, and operational procedures. | local dev (Docker Compose), pipeline stages, GitHub OIDC setup, teardown, secret rotation, cost check |

`docs/README.md` is the index — every new top-level doc gets a line there.

## Conventions

- **Filenames:** kebab-case, `.md`. ADRs are numbered `NNNN-short-title.md` (zero-padded, never renumber or delete — supersede instead).
- **Every doc starts** with an H1 title and a one-line purpose statement.
- **Cross-link** related docs with relative links; link to `file:line` in code where a doc describes a specific implementation.
- **Source of truth is code/IaC, not prose.** When a doc explains *what* a resource is, point to the Terraform/manifest/source rather than restating values that will drift (e.g. instance tiers, replica counts). Document *why* and *how it fits*, which code can't express.
- **No secrets, credentials, real AWS account IDs, ARNs, or resource identifiers** in docs — reference Secrets Manager / SSM / GitHub Actions variables by name only.

## When to write or update docs

- **Architectural decision made** → add an ADR (see `docs/architecture/decisions/_template.md`). Don't bury decisions in commit messages.
- **New service / infra module / pipeline stage** → update `docs/architecture/` and/or `docs/operations/`.
- **New operational action becomes possible** (deploy, rollback, rotate, scale, teardown) → add or update a procedure under `docs/operations/`.
- **Behaviour, config surface, or setup steps change** → update the affected doc in the same PR.

## Ownership

The `documentation-keeper` agent owns the structure and consistency of `docs/`. Delegate documentation creation, restructuring, and audits to it. It must respect this taxonomy and the conventions above.
