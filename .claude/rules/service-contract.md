# Service Contract Rule

Every microservice under `services/` follows this contract. It is the interface between **application code** (which a developer writes) and the **platform** (the modules, pipeline, and IAM that deploy it). If a service meets this contract, the platform can build, deploy, and run it with no service-specific infrastructure work. The `/new-service` command scaffolds services to this contract; `app-engineer`, `terraform-engineer`, and `infra-reviewer` enforce it.

The worked reference is `services/_template/` (the skeleton) and the shared Terraform modules the two app configs wire together (`data` in `app-base/`, `ecs-service` in `app-edge/`, and the cluster module). See [`docs/operations/adding-a-service.md`](../../docs/operations/adding-a-service.md) and [ADR 0003](../../docs/architecture/decisions/0003-base-edge-split.md) for the base/edge split.

## The application contract (what the service code must do)

1. **Config from the environment only — no hardcoded endpoints.** Read the table name, port, and any config from `process.env.*` — never hardcode table names or credentials. **No committed `.env` with real values.** This applies with force to **API base URLs**: neither the React frontend nor any service-to-service call may embed a literal ALB DNS name (`*.elb.amazonaws.com`), IP, or endpoint in source — the base URL is always read from config/env. (The ALB's DNS changes every time the billable edge is torn down and recreated; a hardcoded URL breaks on the next teardown cycle, and it blocks the future move to a stable custom domain. Enforced by a CI grep.)
2. **`GET /health` → `200`, fast, DB-free.** This is the ALB target-group health check. It must return 200 as soon as the process is up and must not depend on the database or any downstream call.
3. **Stateless.** No local disk state; all state lives in the service's own datastore.
4. **One process, containerized.** Ship the standard Dockerfile (small, multi-stage-friendly, **non-root**, `EXPOSE`s the app port, runs one Node process). Listen on `$PORT` (default 3000).
5. **Own your data.** Each service owns exactly its **own DynamoDB table(s)** — no shared database, no reaching into another service's tables. Read/write via the AWS SDK with typed/parameterised calls (no injectable queries).
6. **Tests ship with the service.** At minimum a `/health` test that needs no AWS; behavioural changes ship with tests.
7. **CORS for the browser.** A service the SPA calls **directly from the browser** must return CORS headers (`Access-Control-Allow-Origin` for the SPA's origin, and handle the `OPTIONS` preflight). The SPA is served from the S3 website origin and calls the ALB on a *different* origin, so without CORS the browser blocks the response **even when the ALB is reachable**. (Service-to-service calls don't run in a browser and don't need this.) Read the allowed origin from config/env — don't hardcode it. See [ADR 0004](../../docs/architecture/decisions/0004-frontend-hosting.md).

## The infrastructure contract (how a service is wired — the platform side)

The platform is split by lifecycle into two Terraform configs (see [ADR 0003](../../docs/architecture/decisions/0003-base-edge-split.md)): **`terraform/app-base/`** (permanent, free — network, cluster, IAM, **DynamoDB tables**) and **`terraform/app-edge/`** (destroyable, billable — ALB + services). A service is declared with **two module blocks, one in each config**:

- **In `app-base/`:** `module "<name>_table"` → the `data` module (its DynamoDB table). Lives in BASE so the table — and its **data** — survives an edge teardown.
- **In `app-edge/`:** `module "<name>_service"` → the `ecs-service` module (task definition, ECS service, ALB target group + **listener rule**, task role carrying the **`soa-boundary`** scoped to *its own* table, log group, autoscaling).

**The seam is the injected env.** `app-edge/` injects the table name into the container (e.g. `env = { <NAME>_TABLE = "<name_prefix>-<name>" }`, the same conventional name BASE created it under); the code reads `process.env.<NAME>_TABLE`. EDGE reads the shared foundation (`vpc_id`, `cluster_id`, `execution_role_arn`, `alb_sg_id`, subnets) from BASE via a `terraform_remote_state` data source; the task role scopes to the service's own table by a constructed ARN string. **Both configs are pipeline-applied** — a new service deploys with no manual `terraform` step (the pipeline may create/update tables but has no data-plane or `DeleteTable` access, so it can never delete a table or its data).

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
- **Tables live in `app-base/`; the deployer's DynamoDB grant is control-plane only** — it can create/update/describe/tag a service's table but has **no data-plane access** (`DeleteItem`/`PutItem`/etc.) and **no `DeleteTable`** (with an explicit deny as backstop). So the pipeline can never delete a table *or* touch its rows; data survives every edge teardown, and deleting a table is a deliberate human action.
- **`services/_template/` is never deployed** and never gets a Terraform block — it exists only to be copied.
