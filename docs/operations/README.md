# Operations

Everything about running the system: local setup, the CI/CD pipeline, AWS account setup, and step-by-step operational procedures.

- **What goes here:** local dev (Docker Compose), running tests, the CI/CD pipeline stages, GitHub OIDC → AWS setup, ECS/ECR config, branch gating, and runbooks (teardown, secret rotation, scale/stop, cost check).

## Documents

- [terraform-foundation.md](terraform-foundation.md) — bootstrapping the S3 remote-state backend, init/plan/apply for the root config, the GitHub OIDC keyless-auth model, the `soa-boundary` permissions-boundary pattern, and teardown. Covers [PRD platform/0001](../action_plan/platform/0001-terraform-foundation.md).
