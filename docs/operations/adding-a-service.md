# Adding a Service

The manual "paved road" recipe for wiring a new ECS Fargate service onto the shared compute layer — a service contract to follow in `services/<name>/`, plus two Terraform blocks in `terraform/app/main.tf`. This is a **manual** recipe; a `/new-service` command that scaffolds it is a later, out-of-scope PRD (see [PRD platform/0004 §3](../action_plan/platform/0004-ecs-alb.md)) — until it exists, copy the reference service described below.

Worked example: [`services/items/`](../../services/items/) + its wiring in [`terraform/app/main.tf`](../../terraform/app/main.tf). Background on what these modules do and how the pipeline deploys them: [compute-layer.md](compute-layer.md).

## 1. The service contract

Every service under `services/<name>/` follows the same shape (see [`services/items/`](../../services/items/) as the concrete example):

- **Reads all config from the environment** — table name, port, etc. — never hardcoded and never read from a committed file. Secrets (if a service ever needs one) come from SSM/Secrets Manager at runtime, not from Terraform `env` vars (see `modules/ecs-service` `env` input — plain, non-secret values only).
- **Exposes `GET /health`**, fast and free of any DynamoDB (or other dependency) call, returning `200` as long as the process is up. This is the ALB target group's health check, not a general readiness check — see [`services/items/src/app.js`](../../services/items/src/app.js).
- **Standard Dockerfile shape** — small base image (`node:20-alpine` in the reference), multi-stage/`npm ci --omit=dev` for a lean image, runs as a **non-root user** (`USER node`), exposes the app's port. See [`services/items/Dockerfile`](../../services/items/Dockerfile).
- **Own DynamoDB table(s) only** — no shared database between services (polyglot persistence, per ADR 0001). The service reads its table name from an env var the Terraform wiring supplies (e.g. `ITEMS_TABLE`), never a hardcoded table name.
- **Tests** live alongside the source (`services/<name>/tests/`) and run via the service's own `npm test`; add a local `docker-compose.yml` block for local dev against DynamoDB Local (see the `items` block in the repo-root [`docker-compose.yml`](../../docker-compose.yml) and [`services/items/README.md`](../../services/items/README.md) for the one-time local table bootstrap).

`/health` is the **internal** ALB target-group health-check path — it is not routed externally by the shared listener unless the service's own listener rule also matches it (see [compute-layer.md §6](compute-layer.md#6-health-is-not-externally-routed)). A service's actual route (e.g. `/items*`) is a separate, explicit choice.

## 2. The two Terraform blocks

In [`terraform/app/main.tf`](../../terraform/app/main.tf), copy the `items_table` + `items_service` pair and rename:

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
  priority    = 200            # must be unique across every service's listener rule
  image_tag   = var.image_tag  # or a per-service image_tag var, once more than one service ships independently

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
| `name` | Names the ECR repo, log group, roles, security group, container — must be unique |
| `port` | The container's listening port; also what the task SG opens from the ALB SG |
| `route` | The listener-rule path pattern forwarded to this service (e.g. `/orders*`) |
| `priority` | Listener-rule evaluation order — must be unique across every service on the shared listener |
| `table_arns` | Which DynamoDB table(s) the task role is scoped to (omit/empty if the service has none) |
| `env` | Plain (non-secret) environment variables the container reads at startup |

Everything else — `cpu`/`memory` (default 256/512), `health_check_path` (default `/health`), `desired_count` (default 1, then owned by autoscaling) — has a sane default a first service doesn't need to touch.

Add a matching output in [`terraform/app/outputs.tf`](../../terraform/app/outputs.tf) if CD needs to reference the new service's ECR URL / service name (follow the `items_ecr_repository_url` / `items_service_name` pattern), and extend `cd.yml`'s build/push steps for the new service's image (see [compute-layer.md §4](compute-layer.md#4-pipeline-build-push-deploy)) until the pipeline is generalized to loop over services.

## 3. PR -> CI -> CD flow

Same flow as any other change to `terraform/app/` or `services/**` (see [cicd-pipeline.md §4](cicd-pipeline.md#4-developer-flow)):

1. Branch off `main`, add `services/<name>/` and the two module blocks above.
2. Open a PR — `ci.yml` builds the new service's Docker image and plans `terraform/app/` as `soa-ci-plan`. Branch protection requires this to pass before merge.
3. Merge — `cd.yml` runs as `soa-deployer`: targeted apply of the new service's ECR repo -> build + push the image tagged `$GITHUB_SHA` -> full apply (creates the service's task def, ECS service, target group, listener rule, task role, autoscaling) -> `aws ecs wait services-stable`.
4. Verify: `curl http://<alb-dns-name>/<route>` (get the ALB DNS name from `terraform output alb_dns_name` in `terraform/app/`) — never hardcode the DNS name in a doc or script.

If the new resource types the service needs (a new AWS service integration, not just another ECS service) hit a `soa-deployer` `AccessDenied`, that's a deployer-permission gap fixed by a human apply against the root identity config — see [compute-layer.md §5](compute-layer.md#5-deployer-permissions-grows-with-new-resource-types).

## Related docs

- [compute-layer.md](compute-layer.md) — what the cluster/ALB/modules do and why, in depth.
- [cicd-pipeline.md](cicd-pipeline.md) — the workflows this flow runs through.
- [PRD platform/0004](../action_plan/platform/0004-ecs-alb.md) — the PRD that built the reference service and modules this recipe copies.
