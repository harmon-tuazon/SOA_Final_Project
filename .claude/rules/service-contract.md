# Service Contract Rule

Every microservice under `services/` follows this contract. It is the interface between **application code** (which a developer writes) and the **platform** (the modules, pipeline, and IAM that deploy it). If a service meets this contract, the platform can build, deploy, and run it with no service-specific infrastructure work. The `/new-service` command scaffolds services to this contract; `app-engineer`, `terraform-engineer`, and `infra-reviewer` enforce it.

The worked reference is `services/_template/` (the skeleton) and the modules under `terraform/app/modules/` (`data`, `ecs-service`, `ecs-cluster`). See [`docs/operations/adding-a-service.md`](../../docs/operations/adding-a-service.md).

## The application contract (what the service code must do)

1. **Config from the environment only.** Read the table name, port, and any config from `process.env.*` — never hardcode endpoints, table names, or credentials. No committed `.env` with real values.
2. **`GET /health` → `200`, fast, DB-free.** This is the ALB target-group health check. It must return 200 as soon as the process is up and must not depend on the database or any downstream call.
3. **Stateless.** No local disk state; all state lives in the service's own datastore.
4. **One process, containerized.** Ship the standard Dockerfile (small, multi-stage-friendly, **non-root**, `EXPOSE`s the app port, runs one Node process). Listen on `$PORT` (default 3000).
5. **Own your data.** Each service owns exactly its **own DynamoDB table(s)** — no shared database, no reaching into another service's tables. Read/write via the AWS SDK with typed/parameterised calls (no injectable queries).
6. **Tests ship with the service.** At minimum a `/health` test that needs no AWS; behavioural changes ship with tests.

## The infrastructure contract (how a service is wired — the platform side)

A service is declared in `terraform/app/main.tf` with **two module blocks**:
- `module "<name>_table"` → the `data` module (its DynamoDB table).
- `module "<name>_service"` → the `ecs-service` module (task definition, ECS service, ALB target group + **listener rule**, task role carrying the **`soa-boundary`** scoped to *its own* table, log group, autoscaling).

The service's env is injected from Terraform (e.g. `env = { <NAME>_TABLE = module.<name>_table.name }`) — this is the seam: Terraform creates the table, injects its name, the code reads `process.env.<NAME>_TABLE`.

## Naming conventions (binding — the pipeline relies on these)

For a service named `<name>` (kebab-case, e.g. `order`):
| Thing | Value |
| --- | --- |
| Service folder | `services/<name>/` |
| Terraform modules | `module.<name>_service`, `module.<name>_table` |
| AWS resource names | `soa-<name>` (ECR repo, ECS service, etc.) |
| ALB route | `/<name>*` (or the resource noun, `/<resource>*`) |
| Listener rule priority | unique per service (increment from the last: 100, 110, 120, …) |
| Table env var | `<NAME>_TABLE` (upper snake, e.g. `ORDER_TABLE`) |
| Container port | `3000` unless the service needs otherwise |

The CI/CD pipeline discovers services by listing `services/*` (excluding `_template`) and derives ECR repo / ECS service names as `soa-<name>` — so a service that follows these names deploys automatically.

## What the platform provides (so the developer doesn't)

The shared cluster, single ALB + listener, network (VPC/subnets), ECS task **execution** role, ECR, the CI/CD pipeline, and all IAM/least-privilege. A service author never touches VPCs, IAM, the ALB, or the pipeline — only the two module blocks (usually written by `/new-service`) and their app code.

## Guardrails (non-negotiable)

- **Task role carries the `soa-boundary`** and is scoped to the service's **own** table only. (The deployer's `iam:CreateRole` *requires* the boundary.)
- **Role policies are customer-managed `soa-*`** — never inline, never AWS-managed (the deployer can't attach those).
- **No secrets in code or the image** — config/secrets come from the environment (SSM at runtime for secrets).
- **Images are SHA-tagged**, never `:latest`.
- **`services/_template/` is never deployed** and never gets a Terraform block — it exists only to be copied.
