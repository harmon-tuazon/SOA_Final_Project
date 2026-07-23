# 0001 — Order Service Scaffold

> Scaffold `services/order/` — the first real microservice on the paved road — serving an Amazon-style order-history/order-detail REST API backed by its own DynamoDB table.

## 1. Status & metadata

- **Status:** In Progress <!-- Draft → Approved → In Progress → Done (or Abandoned) -->
- **Date:** 2026-07-22
- **Approved:** 2026-07-22 by the repo owner
- **Author:** Anjuuuzzz (with Claude Code)

> Execution may only start once the user has confirmed **Approved**.

## 2. User story

As a **shopper using the storefront**, I want to **place an order and then see my order history and the detail of any one order — items, quantities, prices, total, status and delivery estimate** — so that I can **track what I bought and how far along it is**, the way an Amazon "Your Orders" screen works.

As the **project team**, we want this to be **the first service proving the paved road end-to-end** (`services/*` discovery → ECR → ECS → ALB route → its own DynamoDB table), so that every later service is a copy of a working pattern rather than a new integration.

## 3. Scope

**In scope:**

- `services/order/` scaffolded from [`services/_template/`](../../../services/_template/), satisfying the [service contract](../../../.claude/rules/service-contract.md) in full.
- An **order REST API** (Express, Node 20) over the entity in §3.1, with the routes in §3.2.
- **CORS** for the S3-hosted SPA origin, read from env (`CORS_ALLOWED_ORIGIN`) — required because the SPA calls the ALB cross-origin (contract §7, [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)).
- Server-side **derivation of `total`, `status`, `placedAt`, `deliveryEstimate`** on create — the client does not get to set them.
- Unit + integration tests (`/health` with no AWS; routes against **DynamoDB Local**).
- A `docker-compose.yml` block for local dev against the existing `dynamodb-local` container. (Local-dev only, provisions nothing; that file declares itself app-engineer-owned at [`docker-compose.yml:1-6`](../../../docker-compose.yml).)
- Docs: the service README, this PRD's Outcome, and the index line.

**Out of scope:**

- **All Terraform.** *(Amendment, 2026-07-22, at the repo owner's direction — infrastructure is owned by the DevOps team.)* This PRD no longer writes `module "order_table"` in [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) or `module "order_service"` in [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf). Those two blocks are still **required for the service to deploy** — they are handed off to DevOps as a spec (§5.1) rather than written here. **Consequence: until DevOps lands them, `services/order/` is buildable, testable and runnable locally, but is not deployed, has no `soa-order` table, and is not reachable on the ALB.** Success criteria §4.4–§4.9 are therefore deferred to that handoff and are not claimed by this PRD.

- ~~**A frontend order screen.**~~ *(Amendment, 2026-07-22 — brought back INTO scope at the repo owner's request, after the backend was built.)* The SPA now has an order-history list and an order-detail page under [`frontend/src/features/orders/`](../../../frontend/src/features/orders/), following the [adding-a-frontend-feature](../../operations/adding-a-frontend-feature.md) recipe. No cost or security impact: it provisions nothing, adds no dependency, and calls the API only through the existing `apiFetch` runtime-config seam. Judged below the threshold for its own PRD (unlike [frontend/0001](../../frontend/0001-spa-scaffold-and-hosting.md), which provisioned S3 hosting).
- **A product service.** Orders store a denormalized snapshot of each line item (`productId`, `name`, `unitPrice`, `qty`) captured at purchase time — the historically correct model for an order screen, and it means no cross-service call. `product` is a later PRD (`product/0001`).
- **Any async path.** No SQS/SNS/Lambda order-confirmation email here — `functions/` does not exist yet and the async factory piece is unbuilt. Follow-up: `platform/0008`.
- **Auth / real customer identity.** `customerId` is taken as an opaque string from the request; Cognito is deferred with HTTPS ([ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)). **This means the API is unauthenticated and any caller can read any `customerId`'s orders** — acceptable for a disposable course demo, called out here deliberately (see §9).
- **A GSI on `customerId`.** The shared [`data`](../../../terraform/modules/data/) module supports a hash key only. Listing uses `Scan` + filter (see §9).
- Payments, inventory, returns, tracking-carrier integration, pagination.
- Any `terraform apply` / `aws` / `docker push` run by hand — the pipeline owns deployment.

### 3.1 Entity — `order`

Partition key `id` (string, server-generated UUID). Stored shape:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | **hash key**; server-generated |
| `customerId` | string | required on create |
| `status` | string | `PLACED` → `SHIPPED` → `DELIVERED`, or `CANCELLED` |
| `items` | list | each: `productId`, `name`, `unitPrice` (number), `qty` (integer ≥ 1) |
| `total` | number | **server-computed** = Σ `unitPrice × qty`, rounded to 2dp |
| `placedAt` | string | server-set ISO-8601 timestamp |
| `shippingAddress` | object | `line1`, `city`, `postalCode`, `country` |
| `deliveryEstimate` | string | server-set ISO-8601 date, `placedAt` + 5 days |
| `updatedAt` | string | server-set ISO-8601 on every status change |

### 3.2 Routes (all under the `/orders*` ALB route)

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | 200, plain text, **DB-free** — ALB target-group check (not externally routed) |
| `GET` | `/orders` | List orders, newest `placedAt` first. `?customerId=` filters (see §9 on `Scan`) |
| `GET` | `/orders/:id` | One order; `404` if unknown |
| `POST` | `/orders` | Create. Validates `customerId`, non-empty `items`, each `qty ≥ 1` integer and `unitPrice ≥ 0`. Server sets `id`/`total`/`status=PLACED`/`placedAt`/`deliveryEstimate`. → `201` + the order; `400` on invalid body |
| `PATCH` | `/orders/:id/status` | Advance status. Legal transitions only: `PLACED→SHIPPED`, `SHIPPED→DELIVERED`. → `200`; `409` on an illegal transition; `404` if unknown |
| `POST` | `/orders/:id/cancel` | Cancel — allowed **only** from `PLACED`. → `200`; `409` otherwise; `404` if unknown |
| `OPTIONS` | `/orders*` | CORS preflight → `204` |

## 4. Success criteria

Each is checkable by a command in §8.

1. `npm test` in `services/order/` passes, covering: `/health` 200 with no AWS creds; create→read round-trip; `total` computed server-side and **not** trusted from the request body; `400` on invalid body; `404` on unknown id; `409` on an illegal status transition and on cancelling a non-`PLACED` order.
2. `docker build services/order/` succeeds and the resulting image runs as a **non-root** user (`docker run --rm --entrypoint id soa-order:test` reports a non-zero uid).
3. `grep -rn "elb\.amazonaws\.com\|dynamodb\.us-" services/order/src` returns **no matches** — no hardcoded endpoints (contract §1, CI-enforced).
4. `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` both pass; `terraform fmt -check` clean in both.
5. `terraform -chdir=terraform/app-edge plan` shows the new service's resources as **creates, 0 destroys** — no existing resource is replaced.
6. Listener rule priority **100** is unique across `app-edge` (currently no service holds any priority).
7. The `order` task role in the plan carries **`soa-boundary`** and its DynamoDB policy is scoped to `soa-order` (+ `/index/*`) **only** — no `*` resource, no AWS-managed policy, no inline policy.
8. After merge, CD is green and `curl -s -o /dev/null -w '%{http_code}' http://<alb-dns>/orders` returns **200** (ALB DNS read from `terraform output`, never hardcoded).
9. A full round-trip against the deployed service: `POST /orders` → `201`, `GET /orders/:id` → the same order, `POST /orders/:id/cancel` → `200` with `status: CANCELLED`.
10. `docs/action_plan/README.md` gains an `order/` group with this PRD listed.

## 5. Resources

**AWS resources created** (all via existing shared modules — no new module is written):

| Resource | Terraform type | Config | Cost |
| --- | --- | --- | --- |
| `soa-order` DynamoDB table | `aws_dynamodb_table` (via `modules/data`) | `app-base` | **Free tier** — PAY_PER_REQUEST, 25 GB + 25 WCU/RCU free; demo traffic is ~$0. Permanent |
| `soa-order` ECR repo | `aws_ecr_repository` (via `modules/ecs-service`) | `app-edge` | **Free tier** — 500 MB/mo private storage |
| `soa-order` ECS service + task definition | `aws_ecs_service`, `aws_ecs_task_definition` | `app-edge` | **Billable** — 1 Fargate task @ 256 CPU / 512 MiB ≈ **$0.012/hr ≈ $9/mo if left running**. Dies on `terraform destroy` of `app-edge` |
| `soa-order` target group + listener rule | `aws_lb_target_group`, `aws_lb_listener_rule` | `app-edge` | **Free** — attaches to the existing shared ALB; no new ALB |
| `soa-order` task role + `soa-order-*` policy | `aws_iam_role`, `aws_iam_policy` | `app-edge` | **Free** |
| `soa-order` task security group | `aws_security_group` | `app-edge` | **Free** |
| `/ecs/soa-order` log group | `aws_cloudwatch_log_group` | `app-edge` | **Free tier** — 5 GB ingest/mo |
| Autoscaling target + policy | `aws_appautoscaling_*` | `app-edge` | **Free** (scaling *out* adds task cost) |

**Net new cost:** ~**$9/mo** of Fargate *while `app-edge` is up*, on top of the existing ~$16/mo ALB. Both return to **$0** on the routine `app-edge` teardown ([cost-lifecycle.md](../../operations/cost-lifecycle.md)). Nothing permanent and billable is added.

**Repo files touched:**

- **New:** `services/order/` (`src/app.js`, `src/index.js`, `src/orders.js`, `Dockerfile`, `package.json`, `.dockerignore`, `.gitignore`, `README.md`, `tests/`).
- **Edited:** [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) (+`module "order_table"`), [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf) (+`module "order_service"`), [`docker-compose.yml`](../../../docker-compose.yml) (+`order` block), [`docs/action_plan/README.md`](../README.md) (index line).
- **Not touched:** `services/_template/`, `terraform/modules/*`, `terraform/` root identity config, the workflows.

**Derived infrastructure** (from the [service contract](../../../.claude/rules/service-contract.md), no decision needed):

| | |
| --- | --- |
| Service folder | `services/order/` |
| AWS names | `soa-order` |
| Table | `soa-order`, hash key `id` |
| Env var | `ORDER_TABLE` = `${var.name_prefix}-order` |
| Other env | `PORT=3000`, `CORS_ALLOWED_ORIGIN` (the S3 website origin) |
| ALB route | `/orders*` |
| Listener priority | **100** (first service; next service takes 110) |
| Port | 3000 |

### 5.1 DevOps handoff — the two Terraform blocks this service needs

Not written by this PRD (see §3 amendment). Handed to the DevOps team verbatim; the shapes below are copied from the canonical commented seams already in each config, so they should drop in unchanged. Recipe context: [adding-a-service.md](../../operations/adding-a-service.md).

**a) The table — append to [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf):**

```hcl
module "order_table" {
  source = "../modules/data"

  name_prefix = var.name_prefix
  name        = "order"
  hash_key    = "id"
}
```

**b) The service — append to [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf):**

```hcl
module "order_service" {
  source = "../modules/ecs-service"

  name_prefix        = var.name_prefix
  region             = var.region
  name               = "order"
  port               = 3000
  image_tag          = var.image_tag
  route              = "/orders*"
  priority           = 100
  env                = { ORDER_TABLE = "${var.name_prefix}-order" }
  table_arns         = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-order"]
  vpc_id             = local.vpc_id
  public_subnet_ids  = local.public_subnet_ids
  cluster_id         = local.cluster_id
  alb_sg_id          = local.alb_sg_id
  listener_arn       = module.alb.listener_arn
  execution_role_arn = local.execution_role_arn
  boundary_arn       = local.boundary_arn
}
```

Notes for whoever applies this:

- **Priority 100 is free** — no service currently holds any listener priority. The next service takes 110.
- **`CORS_ALLOWED_ORIGIN` should be added to `env`** once the S3 website origin is known (it is a `frontend` module output, non-secret). The service defaults to `*` when unset, which works but is permissive.
- This is the **first ever `ecs-service` instantiation** — if `soa-deployer` lacks an ECS/ELB/IAM/ECR permission, CD fails `AccessDenied`; the fix is a human apply on the root identity config, not a looser boundary ([compute-layer.md §5](../../operations/compute-layer.md#5-deployer-permissions-grows-with-new-resource-types)).
- Both configs are pipeline-applied — no manual `terraform apply` should be needed once the blocks are merged.

**External references:** [DynamoDB `Scan` FilterExpression](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html), [`@aws-sdk/lib-dynamodb`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-dynamodb/).

## 6. Scripts / commands

Run locally by the agents — **nothing billable, nothing that touches AWS state**:

```bash
# 1. Scaffold + implement (app-engineer)
cp -r services/_template services/order        # then replace the three tokens
cd services/order && npm install && npm test
npm run lint                                   # if the template defines one

# 2. Local integration against DynamoDB Local
docker compose up -d dynamodb-local
docker compose up --build order
curl -s localhost:3000/health
docker compose down

# 3. Image check
docker build -t soa-order:test services/order
docker run --rm --entrypoint id soa-order:test   # must NOT be uid=0

# 4. Terraform (terraform-engineer) — validate/plan ONLY, never apply
terraform -chdir=terraform/app-base fmt -check
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge fmt -check
terraform -chdir=terraform/app-edge validate
terraform -chdir=terraform/app-edge plan        # read-only; expect creates, 0 destroys

# 5. Contract grep
grep -rn "elb\.amazonaws\.com" services/order/src   # must be empty

# 6. PR
git checkout -b feat/order-service && git commit && git push && gh pr create
```

**Billable / destructive commands run by the pipeline, not by hand** (listed here because §6 requires naming them):

- `cd.yml` → `terraform -chdir=terraform/app-base apply -auto-approve` — **creates the `soa-order` table**.
- `cd.yml` → `docker build` + `docker push` of `soa-order:$GITHUB_SHA` to ECR.
- `cd.yml` → `terraform -chdir=terraform/app-edge apply -auto-approve` — **creates the billable ECS service**.
- `cd.yml` → `aws ecs wait services-stable`.

**No `terraform apply`, `terraform destroy`, `aws`, or `docker push` is run from this session.**

**Deployment is fully self-serve — there is no manual `terraform` step.** On merge, `cd.yml` applies **`app-base`** (creating the `soa-order` table on its own, because the deployer is scoped to create/update `soa-*` tables), then discovers `services/order` under `services/*`, builds and pushes `soa-order:$GITHUB_SHA` to ECR, and applies **`app-edge`** (task definition, ECS service, target group, listener rule, task role, autoscaling), then waits for the service to stabilize. A human never runs Terraform for this service. The pipeline **can** create the table but is explicitly **denied `dynamodb:DeleteTable`** and has **no data-plane access** ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)) — so no pipeline run, however broken, can delete the table or a single order row.

## 7. Planned agents

| Step | Agent | Hands off |
| --- | --- | --- |
| 1. Scaffold `services/order/` from `_template`, replace tokens, implement the entity/routes/validation/CORS in §3, write unit + DynamoDB-Local integration tests, add the `docker-compose.yml` block, run `npm test` + `docker build` | **`app-engineer`** | A green, containerized service meeting the contract |
| 2. ~~Terraform blocks~~ | ~~`terraform-engineer`~~ | **Dropped by the §3 amendment** — infra is the DevOps team's. Specified instead in §5.1 for handoff |
| 3. ~~Plan/diff audit~~ | ~~`infra-reviewer`~~ | **Dropped** — no Terraform diff to review in this PRD. DevOps should run this pass on their own PR |
| 4. Update `docs/action_plan/README.md`, cross-link, and refresh `docs/architecture/overview.md` (which currently names a non-existent `services/items/` as the reference service — **pre-existing doc drift this work should correct**) | **`documentation-keeper`** | Consistent docs |
| 5. PRD authoring, agent orchestration, branch + PR, Outcome note | **main session** | This PRD, the PR |

## 8. Testing / verification plan

Mapping every §4 criterion to a check:

| §4 | Verification |
| --- | --- |
| 1 | `cd services/order && npm test` — assert the listed cases pass, including a test that `POST /orders` with an attacker-supplied `total: 0.01` still stores the computed total |
| 2 | `docker build -t soa-order:test services/order` then `docker run --rm --entrypoint id soa-order:test` → uid ≠ 0 |
| 3 | `grep -rn "elb\.amazonaws\.com\|dynamodb\.us-" services/order/src` → no output |
| 4 | `terraform -chdir=terraform/app-base fmt -check && validate`; same for `app-edge` → exit 0 |
| 5 | `terraform -chdir=terraform/app-edge plan` → read the summary line; expect `0 to destroy` |
| 6 | Grep `priority` in `terraform/app-edge/main.tf` → `100` appears exactly once |
| 7 | **`infra-reviewer` pass** over the diff + plan: `permissions_boundary` set on the task role, policy `Resource` lists only the `soa-order` table ARN + `/index/*`, policy is customer-managed `soa-*` |
| 8 | Post-merge: `ALB=$(terraform -chdir=terraform/app-edge output -raw alb_dns_name)` then `curl -s -o /dev/null -w '%{http_code}' "http://$ALB/orders"` → `200` |
| 9 | Post-merge smoke: `curl -XPOST "http://$ALB/orders" -H 'content-type: application/json' -d '{"customerId":"c1","items":[{"productId":"p1","name":"Widget","unitPrice":9.99,"qty":2}],"shippingAddress":{...}}'` → `201`, `total: 19.98`; then `GET /orders/<id>` → same; then `POST /orders/<id>/cancel` → `200`, `status: CANCELLED`; then repeat cancel → `409` |
| 10 | Read `docs/action_plan/README.md` |

Plus the automatic gates: `ci.yml` discovers `services/order`, builds it, and plans both configs as `soa-ci-plan`; branch protection blocks merge until green. CloudWatch Logs (`/ecs/soa-order`) is checked after the first deploy for clean startup.

## 9. Additional considerations

**`Scan` instead of a `customerId` GSI.** The shared [`data` module](../../../terraform/modules/data/) creates a hash-key-only table, so `GET /orders?customerId=` is a `Scan` with a `FilterExpression`. At course-demo scale (tens of orders) this is correct and free; at real scale it is not. Adding a GSI means extending the `data` module — a deliberate platform change, so it is a **follow-up PRD**, not silently smuggled in here. Documented in the service README so the limitation isn't discovered by surprise.

**No auth is a real gap, accepted knowingly.** Any caller who can reach the ALB can read or cancel any order. This is inherent to the deferred-auth posture in [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md) (Cognito needs HTTPS, which needs CloudFront), not something this PRD introduces — but it is worth stating plainly rather than leaving implied. **Do not put real personal data in this demo.** The fix lands with the HTTPS/Cognito PRD.

**Rollback / teardown.** The ECS service, target group, listener rule, task role, SG, log group and ECR repo all live in `app-edge` and vanish on the routine `terraform destroy` — spend returns to the ALB-only baseline, then $0. The **`soa-order` table lives in `app-base` and survives**, by design: the pipeline can create/update it but is explicitly denied `dynamodb:DeleteTable` and has no data-plane access ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)), so no pipeline run can destroy order data. Deleting the table is a deliberate human action. A bad deploy rolls back by redeploying the previous SHA-tagged task definition; a failed ALB health check stops the rollout on the last good task set.

**Security posture.** Net change is one new least-privilege task role scoped to one table, carrying `soa-boundary` — the posture the platform was built for, exercised for the first time. No new inbound exposure beyond one more path rule on the existing ALB; the task SG accepts port 3000 from the ALB SG only. No secrets are introduced (`ORDER_TABLE` and `CORS_ALLOWED_ORIGIN` are non-sensitive).

**Deployer-permission risk.** This is the **first** `ecs-service` module instantiation ever applied. If `soa-deployer` is missing an ECS/ELB/IAM/ECR permission, CD fails with `AccessDenied` — fixed by a human apply against the root identity config ([compute-layer.md §5](../../operations/compute-layer.md#5-deployer-permissions-grows-with-new-resource-types)), not by loosening the boundary. Expect this to be where friction shows up, and budget a follow-up commit for it.

**`image_tag` bootstrap.** No `soa-order` image exists until CD pushes one, but `app-edge`'s apply creates the task definition. CD's documented order (targeted ECR-repo apply → build/push → full apply) handles this; if the first apply still races, `image_tag = "bootstrap"` is the documented escape hatch ([`ecs-service/variables.tf:36`](../../../terraform/modules/ecs-service/variables.tf)).

**Doc drift found while planning (unrelated to this work, worth fixing here).** [`docs/architecture/overview.md`](../../architecture/overview.md) states "The `items` service (`services/items/`) is the reference instance proving this pattern end-to-end" — `services/items/` **does not exist**. `order` becomes the real reference instance; step 4 of §7 corrects that sentence.

**Follow-ups this PRD deliberately leaves open:** `frontend/0002` (the order screen), `product/0001` (product service — the rubric's second service), `platform/0008` (the SQS→Lambda→SNS confirmation path, needed for the rubric's async requirement and for `functions/` to exist at all).

---

## Outcome

**Partially executed — application half done, infrastructure half handed off.** 2026-07-22.

### What was built

`services/order/`, scaffolded from `_template` with all three tokens replaced, implementing every route and rule in §3.2:

- `src/orders.js` — pure domain logic (validation, `computeTotal`, transition rules, `buildOrderFromInput`), no HTTP or AWS imports.
- `src/app.js` — the Express app: `/health` (left DB-free, untouched from the template), the five order routes, and a hand-rolled env-driven CORS middleware (no `cors` dependency added).
- `tests/` — 3 suites, **64 tests, all passing** with no AWS credentials, DynamoDB mocked via a Jest module mock. Includes the §4.1 attacker-payload test: `POST /orders` carrying `total: 0.01, status: "DELIVERED"` still stores the server-computed `24.98` and `PLACED`.
- `README.md` documenting routes, env vars, local run, and both known limitations.
- `docker-compose.yml` — an `order` block against the existing `dynamodb-local`.

### Frontend (added after the backend, by amendment)

`frontend/src/features/orders/` — built to the [adding-a-frontend-feature](../../operations/adding-a-frontend-feature.md) recipe:

- `api.ts` — typed `Order`/`OrderItem`/`ShippingAddress` interfaces mirroring the service's payloads, plus `useOrders(customerId?)`, `useOrder(id)`, `useCreateOrder`, `useCancelOrder`, `useUpdateOrderStatus`. Every call goes through `apiFetch`, so the ALB URL stays runtime config. `CreateOrderInput` deliberately omits `id`/`total`/`status`/timestamps — the server owns them, and the type makes that impossible to get wrong from the client.
- `OrdersPage.tsx` — "Your Orders" history list: per-order card with placed date, total, status, delivery estimate, line-item summary, detail link, and a Cancel button shown only for `PLACED` (matching the service's 409 rule). Plus a "place a demo order" button using a fixed sample basket, since there is no cart or product service.
- `OrderDetailPage.tsx` — order summary: shipping address, full line-item table with subtotals and total, and the status actions legal from the current state.
- Two routes registered in `router.tsx` (`/orders`, `/orders/:id`, both wrapped in the `ProtectedRoute` stub) and a "Your Orders" nav link in `Layout.tsx`.

Verified: `npm run typecheck` clean, `npm run build` succeeds (91 modules), `grep -rn "elb\.amazonaws\.com" frontend/src` empty, and no bare `fetch(` outside `lib/api.ts`. Every page handles loading / backend-unavailable / empty states, because **the order service is not deployed yet** — until the §5.1 handoff lands, these pages will render their "Backend unavailable" state, which is expected, not a bug.

### Deviation from plan

**All Terraform was dropped from this PRD mid-execution**, at the repo owner's direction: infrastructure is owned by a separate DevOps team. §3 and §7 were amended and re-confirmed before work continued, per the [action-plan rule](../../../.claude/rules/action-plan.md). The two required module blocks are specified verbatim in **§5.1** for handoff. `terraform/` was not modified — confirmed by `git status`.

### Success criteria status

| Criterion | Result |
| --- | --- |
| §4.1 `npm test` incl. server-authoritative total | **Met** — 58/58 pass |
| §4.2 non-root image | **Not verified** — Docker unavailable in the execution environment. The template `Dockerfile`'s `USER node` is unchanged, so it should hold, but it was not observed |
| §4.3 no hardcoded endpoints | **Met** — grep clean over `src/` and `tests/` |
| §4.4–§4.9 (Terraform validate/plan, boundary/table scoping, priority, deployed `curl` round-trip) | **Deferred** — depend on the DevOps handoff in §5.1 |
| §4.10 index line | **Met** |

### Review defects — found, then fixed on request

Both were flagged at review rather than silently patched, then fixed when the owner approved the extra scope:

- **Non-atomic `Get`-then-`Update`** on `PATCH /status` and `POST /cancel` — two concurrent requests could both pass the transition check and the second would silently overwrite the first. **Fixed:** both writes now carry `ConditionExpression: '#status = :expectedStatus'` pinned to the status that was read, and a `ConditionalCheckFailedException` maps to **409** (not 500), matching what the pre-flight check returns. No IAM change needed — a condition is part of the existing `UpdateItem` grant.
- **Repeated `?customerId=a&customerId=b`** arrived as an array and would have produced a 500. **Fixed:** rejected with a **400** before any DynamoDB call.

Covered by 6 new tests (asserting the actual `ConditionExpression` and `:expectedStatus` sent to DynamoDB, the 409-on-race behaviour for both routes, that a *genuine* SDK failure still yields 500, and the 400 short-circuit). Suite is now **64 tests, all passing**.

### Known limitations carried forward

- The `Scan`-not-GSI and unauthenticated-API limitations from §9 stand as designed.

### Follow-ups

- **DevOps:** land §5.1's two blocks — until then the service is local-only, not reachable on the ALB, and the SPA's order pages show their backend-unavailable state.
- ~~`frontend/0002` (order screen)~~ — done here by amendment, see above.
- `product/0001` (second service, rubric), `platform/0008` (SQS→Lambda→SNS async path, rubric).

Status stays **In Progress** until the §5.1 handoff lands and §4.4–§4.9 can be verified.
