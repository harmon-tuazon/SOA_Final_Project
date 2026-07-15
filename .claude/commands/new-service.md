# /new-service — scaffold a new microservice on the paved road

Create a new, fully-wired microservice (app code **+** Terraform) from `services/_template/`, following the [service contract](../rules/service-contract.md). The developer only describes the service in application terms; you derive and generate the infrastructure. **Do not create cloud resources directly** — you produce code + a PR; the pipeline deploys it after human review.

**Argument:** an optional service name (e.g. `/new-service order`). If omitted, ask for it first.

## Guardrails for you (the assistant) running this

- Ask the interview questions **at the application level only** — never ask the developer about VPCs, IAM, ALBs, or Terraform. You derive all of that.
- **Gate on approval:** generate the per-service PRD and STOP. Do not scaffold until the user marks it approved (this follows [`.claude/rules/action-plan.md`](../rules/action-plan.md)).
- Follow the [service contract](../rules/service-contract.md) naming conventions exactly (the pipeline relies on them).
- Delegate: app code → `app-engineer`; Terraform blocks → `terraform-engineer`; a review pass → `infra-reviewer`.

## Step 1 — Interview (app-level, one question at a time)

Ask, one at a time, and recommend a default for each:
1. **Service name** — kebab-case, singular (e.g. `order`). Validate it's unique (no existing `services/<name>/`).
2. **One-line purpose** — what it does.
3. **Main entity + key fields** — e.g. "an order: `id`, `customerId`, `items`, `status`". The **partition key** is usually `id`.
4. **Routes** — the REST endpoints (e.g. `GET /orders`, `POST /orders`, `POST /orders/:id/cancel`). Everything sits under one path prefix.
5. **Any background/async work?** — e.g. "email a confirmation when an order is placed." If yes, note it as a **follow-up** (async workers — SQS/Lambda — are a separate factory piece not yet built); scaffold the sync service now.

## Step 2 — Derive the infrastructure (you, silently)

From the answers, derive (per the [service contract](../rules/service-contract.md)):
- **DynamoDB table:** `module "<name>_table"` (goes in **`terraform/app-base/`** — tables are permanent), hash key from step 3 (usually `id`).
- **ECS service:** `module "<name>_service"` (goes in **`terraform/app-edge/`** — the destroyable billable layer).
- **ALB route:** `/<name>*` (or the resource noun), a **unique listener rule priority** (read `terraform/app-edge/main.tf` for the highest existing priority and add 10; start at 100).
- **Env var:** `<NAME>_TABLE` (upper snake), injected with the conventional table name `"<name_prefix>-<name>"`.
- **Port:** 3000.

## Step 3 — Generate the per-service PRD (then STOP)

Create `docs/action_plan/<name>/0001-service-scaffold.md` from [`docs/action_plan/_template.md`](../../docs/action_plan/_template.md): the **app spec** (entity, routes) and the **auto-derived infra** (table block in `app-base/`, service block in `app-edge/`, route, env var), success criteria (`/health` 200, the routes round-trip through DynamoDB), and the standard PR→CI→CD flow. Note in the PRD that deployment is **fully self-serve** — on merge, CD applies `app-base` (creates the table) then `app-edge` (deploys the service) with **no manual `terraform` step**; the pipeline may create the table but is denied `dynamodb:DeleteTable`, so it can never delete data. Add its line to `docs/action_plan/README.md` under a `<name>/` group.

**Present it and wait for the user to approve.** Do not proceed to Step 4 until they confirm.

## Step 4 — Scaffold (only after approval)

1. **Copy** `services/_template/` → `services/<name>/`, then replace the placeholder tokens throughout: `__SERVICE_NAME__` → `<name>`, `__RESOURCE__` → the route noun, `__TABLE_ENV__` → `<NAME>_TABLE`.
2. **`app-engineer`:** implement the routes from the PRD in `services/<name>/src/` (keep `/health` DB-free), add tests. Add the service to `docker-compose.yml` for local dev.
3. **`terraform-engineer`:** add **two** blocks in **two** configs, following the pattern in [`docs/operations/adding-a-service.md`](../../docs/operations/adding-a-service.md), [ADR 0003](../../docs/architecture/decisions/0003-base-edge-split.md), and the canonical example already wired in `terraform/app-edge/main.tf`:

   **a) The table — in `terraform/app-base/main.tf`:**
   ```hcl
   module "<name>_table" {
     source      = "../modules/data"      # match the modules path used by the split
     name_prefix = var.name_prefix
     name        = "<name>"
     hash_key    = "id"
   }
   ```
   **b) The service — in `terraform/app-edge/main.tf`** (foundation values come from BASE via the `local.*` aliases already defined there from `terraform_remote_state`; the table is scoped by a constructed ARN string, not a cross-module ref):
   ```hcl
   module "<name>_service" {
     source             = "../modules/ecs-service"
     name_prefix        = var.name_prefix
     region             = var.region
     name               = "<name>"
     port               = 3000
     image_tag          = var.image_tag
     route              = "/<name>*"
     priority           = <next unique priority>   # e.g. 100, then 110, 120, …
     env                = { <NAME>_TABLE = "${var.name_prefix}-<name>" }
     table_arns         = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-<name>"]
     vpc_id             = local.vpc_id
     public_subnet_ids  = local.public_subnet_ids
     cluster_id         = local.cluster_id
     alb_sg_id          = local.alb_sg_id
     listener_arn       = module.alb.listener_arn
     execution_role_arn = local.execution_role_arn
     boundary_arn       = local.boundary_arn
   }
   ```
   This mirrors the commented `example_service` seam already in `terraform/app-edge/main.tf` — that file is the source of truth for the module interface, so copy its exact shape. Run `terraform -chdir=terraform/app-base fmt`/`validate` and `terraform -chdir=terraform/app-edge fmt`/`validate`.
4. **`infra-reviewer`:** confirm the task role carries the boundary + is table-scoped, the listener priority is unique, no billable surprises.

## Step 5 — Open a PR

Create a branch, commit (`services/<name>/`, the Terraform blocks, docs), push, and open a PR. Tell the user: CI will run; on merge, CD builds + deploys the new service automatically (the pipeline discovers it under `services/*`). The `<name>` route will be live behind the ALB.

## What you must NOT do

- Do not run `terraform apply`, `aws`, or `docker` deploys — the pipeline owns deployment.
- Do not skip the PRD approval gate.
- Do not touch `services/_template/`, the shared modules, or the identity config.
