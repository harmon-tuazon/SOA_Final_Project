# Adding a Service

How a new ECS Fargate service gets wired onto the shared compute layer: a service contract every service follows, plus two Terraform blocks in `terraform/app/main.tf`. There are two paths to get there — the automated `/new-service` command (recommended) and a manual copy-from-template recipe — both produce the same shape and are bound by the same contract.

Worked skeleton: [`services/_template/`](../../services/_template/) (never deployed — copied). Background on what the modules do and how the pipeline deploys them: [compute-layer.md](compute-layer.md). The binding contract both paths must satisfy: [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md).

## 1. The service contract

Every service under `services/<name>/` follows the same shape — the full, binding rule is [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md); summarized here:

- **Reads all config from the environment** — table name, port, etc. — never hardcoded and never read from a committed file. Secrets (if a service ever needs one) come from SSM/Secrets Manager at runtime, not from Terraform `env` vars (see `modules/ecs-service` `env` input — plain, non-secret values only).
- **Exposes `GET /health`**, fast and free of any DynamoDB (or other dependency) call, returning `200` as long as the process is up. This is the ALB target group's health check, not a general readiness check — see [`services/_template/src/app.js`](../../services/_template/src/app.js).
- **Standard Dockerfile shape** — small base image (`node:20-alpine` in the template), multi-stage/`npm ci --omit=dev` for a lean image, runs as a **non-root user** (`USER node`), exposes the app's port. See [`services/_template/Dockerfile`](../../services/_template/Dockerfile).
- **Own DynamoDB table(s) only** — no shared database between services (polyglot persistence, per ADR 0001). The service reads its table name from an env var the Terraform wiring supplies (e.g. `<NAME>_TABLE`), never a hardcoded table name.
- **Tests** live alongside the source (`services/<name>/tests/`) and run via the service's own `npm test`; add a local `docker-compose.yml` block for local dev against DynamoDB Local.

`/health` is the **internal** ALB target-group health-check path — it is not routed externally by the shared listener unless the service's own listener rule also matches it (see [compute-layer.md §6](compute-layer.md#6-health-is-not-externally-routed)). A service's actual route (e.g. `/orders*`) is a separate, explicit choice.

## 2. Two ways to add a service

### Path A — `/new-service` (recommended)

[`.claude/commands/new-service.md`](../../.claude/commands/new-service.md) automates the whole flow: an app-level interview (name, purpose, entity/fields, routes, async needs) → it derives the infrastructure (table hash key, ALB route, listener priority, env var) → generates a per-service PRD under `docs/action_plan/<name>/0001-service-scaffold.md` and **stops for approval** → on approval, scaffolds `services/<name>/` from `_template`, adds the two Terraform blocks below, runs `fmt`/`validate`/`npm test`, and opens a PR. It never runs `terraform apply`, `aws`, or `docker` deploy commands directly — the pipeline deploys after human review, per the [action-plan rule](../../.claude/rules/action-plan.md).

Run it as `/new-service <name>` (name optional — it will ask).

### Path B — manual recipe

Useful when scaffolding by hand or reviewing what `/new-service` produces:

1. **Copy the skeleton:** `services/_template/` → `services/<name>/`, then replace the placeholder tokens (`__SERVICE_NAME__`, `__RESOURCE__`, `__TABLE_ENV__`) throughout — see [`services/_template/README.md`](../../services/_template/README.md) for the token table.
2. **Add the two Terraform blocks** to [`terraform/app/main.tf`](../../terraform/app/main.tf), following the pattern below (also documented in [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md)):

```hcl
module "<name>_table" {
  source = "./modules/data"

  name_prefix = var.name_prefix
  name        = "<name>"
  hash_key    = "id"          # or whatever the service's partition key is
}

module "<name>_service" {
  source = "./modules/ecs-service"

  name_prefix = var.name_prefix
  region      = var.region
  name        = "<name>"
  port        = 3000          # the service's listening port
  route       = "/<name>*"    # path pattern the shared listener forwards to this service
  priority    = 100            # must be unique across every service's listener rule
  image_tag   = var.image_tag

  table_arns = [module.<name>_table.arn]
  env = {
    <NAME>_TABLE = module.<name>_table.name
  }

  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  cluster_id         = module.cluster.cluster_id
  alb_sg_id          = module.cluster.alb_sg_id
  listener_arn       = module.cluster.listener_arn
  execution_role_arn = module.cluster.execution_role_arn
  boundary_arn       = local.boundary_arn
}
```

Inputs a new service actually sets (everything else is either a shared default or wired from the cluster/network modules, per [`modules/ecs-service/variables.tf`](../../terraform/app/modules/ecs-service/variables.tf)):

| Input | What it controls |
| --- | --- |
| `name` | Names the ECR repo, log group, roles, security group, container — must be unique (also `soa-<name>` for AWS resource names, per the [service contract](../../.claude/rules/service-contract.md)) |
| `port` | The container's listening port; also what the task SG opens from the ALB SG |
| `route` | The listener-rule path pattern forwarded to this service (e.g. `/orders*`) |
| `priority` | Listener-rule evaluation order — must be unique across every service on the shared listener (increment from the highest existing: 100, 110, 120, …) |
| `table_arns` | Which DynamoDB table(s) the task role is scoped to (omit/empty if the service has none) |
| `env` | Plain (non-secret) environment variables the container reads at startup |

Everything else — `cpu`/`memory` (default 256/512), `health_check_path` (default `/health`), `desired_count` (default 1, then owned by autoscaling) — has a sane default a first service doesn't need to touch.

No per-service Terraform output is required: the pipeline derives each image's registry/repo path from the account + region and the `soa-<name>` naming convention (see [compute-layer.md §4](compute-layer.md#4-pipeline-build-push-deploy)) — it does not read a per-service output.

## 3. PR -> CI -> CD flow

Same flow as any other change to `terraform/app/` or `services/**` (see [cicd-pipeline.md §4](cicd-pipeline.md#4-developer-flow)), now generalized to any number of services:

1. Branch off `main`, add `services/<name>/` and the two module blocks above (or let `/new-service` do it after PRD approval).
2. Open a PR — `ci.yml` discovers every directory under `services/*` except `_template`, builds each one's Docker image, and plans `terraform/app/` as `soa-ci-plan`. Branch protection requires this to pass before merge.
3. Merge — `cd.yml` runs as `soa-deployer`: discovers the same `services/*` set, targeted-applies each service's ECR repo -> builds + pushes each image as `soa-<name>:$GITHUB_SHA` -> one full apply (creates/updates every discovered service's task def, ECS service, target group, listener rule, task role, autoscaling) -> `aws ecs wait services-stable` per service. With zero services present, CD just applies the shared network + cluster + ALB.
4. Verify: `curl http://<alb-dns-name>/<route>` (get the ALB DNS name from `terraform output alb_dns_name` in `terraform/app/`) — never hardcode the DNS name in a doc or script.

If the new resource types the service needs (a new AWS service integration, not just another ECS service) hit a `soa-deployer` `AccessDenied`, that's a deployer-permission gap fixed by a human apply against the root identity config — see [compute-layer.md §5](compute-layer.md#5-deployer-permissions-grows-with-new-resource-types).

## Related docs

- [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md) — the binding contract (naming conventions, app + infra requirements) both paths must satisfy.
- [`.claude/commands/new-service.md`](../../.claude/commands/new-service.md) — the automated interview → PRD → scaffold → PR command.
- [compute-layer.md](compute-layer.md) — what the cluster/ALB/modules do and why, in depth.
- [cicd-pipeline.md](cicd-pipeline.md) — the workflows this flow runs through.
- [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) — the PRD that built the compute layer and modules this recipe wires into.
- [PRD platform/0005](../action_plan/platform/0005-service-factory.md) — the PRD that extracted `_template`, wrote the service contract, built `/new-service`, and generalized the pipeline over `services/*`.
