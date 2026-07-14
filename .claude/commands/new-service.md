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
- **DynamoDB table:** `module "<name>_table"`, hash key from step 3 (usually `id`).
- **ALB route:** `/<name>*` (or the resource noun), a **unique listener rule priority** (read `terraform/app/main.tf` for the highest existing priority and add 10; start at 100).
- **Env var:** `<NAME>_TABLE` (upper snake).
- **Port:** 3000.

## Step 3 — Generate the per-service PRD (then STOP)

Create `docs/action_plan/<name>/0001-service-scaffold.md` from [`docs/action_plan/_template.md`](../../docs/action_plan/_template.md): the **app spec** (entity, routes) and the **auto-derived infra** (table, route, env var, the two module blocks), success criteria (`/health` 200, the routes round-trip through DynamoDB), and the standard PR→CI→CD flow. Add its line to `docs/action_plan/README.md` under a `<name>/` group.

**Present it and wait for the user to approve.** Do not proceed to Step 4 until they confirm.

## Step 4 — Scaffold (only after approval)

1. **Copy** `services/_template/` → `services/<name>/`, then replace the placeholder tokens throughout: `__SERVICE_NAME__` → `<name>`, `__RESOURCE__` → the route noun, `__TABLE_ENV__` → `<NAME>_TABLE`.
2. **`app-engineer`:** implement the routes from the PRD in `services/<name>/src/` (keep `/health` DB-free), add tests. Add the service to `docker-compose.yml` for local dev.
3. **`terraform-engineer`:** add to `terraform/app/main.tf`, following the pattern documented in [`docs/operations/adding-a-service.md`](../../docs/operations/adding-a-service.md) and the `data` / `ecs-service` module interfaces:
   ```hcl
   module "<name>_table" {
     source      = "./modules/data"
     name_prefix = var.name_prefix
     name        = "<name>"
     hash_key    = "id"
   }
   module "<name>_service" {
     source             = "./modules/ecs-service"
     name_prefix        = var.name_prefix
     region             = var.region
     name               = "<name>"
     route              = "/<name>*"
     priority           = <next unique priority>   # e.g. 100, then 110, 120, …
     port               = 3000
     image_tag          = var.image_tag
     table_arns         = [module.<name>_table.arn]
     env                = { <NAME>_TABLE = module.<name>_table.name }
     vpc_id             = module.network.vpc_id
     public_subnet_ids  = module.network.public_subnet_ids
     cluster_id         = module.cluster.cluster_id
     alb_sg_id          = module.cluster.alb_sg_id
     listener_arn       = module.cluster.listener_arn
     execution_role_arn = module.cluster.execution_role_arn
     boundary_arn       = local.boundary_arn
   }
   ```
   (Required module inputs: `name_prefix`, `region`, `name`, `route`, `priority`, `port`, `image_tag`, `vpc_id`, `public_subnet_ids`, `cluster_id`, `alb_sg_id`, `listener_arn`, `execution_role_arn`, `boundary_arn`. `cpu`/`memory`/`health_check_path`/`table_arns`/`env`/`desired_count` have sensible defaults.)
   Run `terraform fmt` + `validate`.
4. **`infra-reviewer`:** confirm the task role carries the boundary + is table-scoped, the listener priority is unique, no billable surprises.

## Step 5 — Open a PR

Create a branch, commit (`services/<name>/`, the Terraform blocks, docs), push, and open a PR. Tell the user: CI will run; on merge, CD builds + deploys the new service automatically (the pipeline discovers it under `services/*`). The `<name>` route will be live behind the ALB.

## What you must NOT do

- Do not run `terraform apply`, `aws`, or `docker` deploys — the pipeline owns deployment.
- Do not skip the PRD approval gate.
- Do not touch `services/_template/`, the shared modules, or the identity config.
