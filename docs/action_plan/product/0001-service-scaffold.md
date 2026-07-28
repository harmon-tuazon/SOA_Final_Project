# 0001 — Product Service Scaffold

> Scaffold `services/product/` — an Amazon-style product-catalog REST API backed by its own DynamoDB table — plus the SPA catalog/detail screens that consume it.

## 1. Status & metadata

- **Status:** In Progress <!-- Draft → Approved → In Progress → Done (or Abandoned) -->
- **Date:** 2026-07-27
- **Approved:** 2026-07-27 by the repo owner
- **Author:** (with Claude Code)

> Execution may only start once the user has confirmed **Approved**.

## 2. User story

As a **shopper browsing the storefront**, I want to **see a catalog of products with names, images, prices, categories and stock, filter it by category, search it by keyword, and open any one product to read its full detail** — so that I can **find something to buy**, the way an Amazon search-results page and product page work.

As the **project team**, we want the **second synchronous microservice** the rubric requires ("at least two functional services"), proving the paved road is repeatable: a second service that lands on the shared cluster/ALB with nothing but two module blocks and its own code.

## 3. Scope

**In scope:**

- `services/product/` scaffolded from [`services/_template/`](../../../services/_template/), satisfying the [service contract](../../../.claude/rules/service-contract.md) in full.
- A **product REST API** (Express, Node 20 — same stack as `order`) over the entity in §3.1, with the routes in §3.2.
- **CORS** for the S3-hosted SPA origin, read from env (`CORS_ALLOWED_ORIGIN`) — the SPA calls the ALB cross-origin (contract §7, [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md)).
- Server-side ownership of `id`, `createdAt`, `updatedAt` — the client never sets them.
- **Atomic stock adjustment** (`PATCH /products/:id/stock`) using a conditional `UpdateItem`, so concurrent decrements cannot oversell — carrying forward the race-condition lesson from [order/0001](../order/0001-service-scaffold.md#review-defects--found-then-fixed-on-request).
- Unit + integration tests, no AWS credentials required (DynamoDB mocked, same pattern as `services/order/tests/`).
- A `product` block in [`docker-compose.yml`](../../../docker-compose.yml) for local dev against the existing `dynamodb-local`.
- **Both Terraform blocks in this same PR** — `module "product_table"` in [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) and `module "product_service"` in [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf). This is binding per the order/0001 Outcome: splitting the code and its module blocks across PRs red-builds `main`, because `cd.yml` discovers `services/*` and pushes to an ECR repo that only the `ecs-service` module creates.
- **Frontend:** replace the placeholder stub in [`frontend/src/features/products/`](../../../frontend/src/features/products/) with a real catalog grid (category filter + keyword search), a product detail page, and a create/edit form. Plain/unstyled, matching the existing pages — per the [adding-a-frontend-feature](../../operations/adding-a-frontend-feature.md) recipe.

**Out of scope:**

- **Order → product service-to-service calls.** The order service keeps its denormalized line-item snapshot (`productId`, `name`, `unitPrice`, `qty` captured at purchase time). Making `POST /orders` validate against the product service and decrement stock is a **follow-up: `order/0002`**. Deliberately excluded so this PR doesn't modify a service that is already deployed and green, and so the Service Connect wiring is decided on its own merits.
- **Any async path.** No SQS/SNS/Lambda here — still `platform/0008`.
- **Auth / admin separation.** `POST`/`PATCH`/`DELETE` are unauthenticated, exactly like the order service. **Any caller who can reach the ALB can create or delete a product.** Inherent to the deferred-auth posture of [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md), not introduced here — but stated plainly (see §9).
- **A GSI on `category`.** The shared [`data`](../../../terraform/modules/data/) module supports a hash key only, so `?category=` and `?q=` are a `Scan` + `FilterExpression` (see §9).
- **Image upload / S3 media.** `imageUrl` is a plain string the caller supplies; the service stores no binaries.
- Reviews, ratings-as-user-submissions, variants/SKUs, inventory reservations, pricing history, pagination, discounts.
- Changes to `services/_template/`, `terraform/modules/*`, the root identity config, or the workflows.
- Any `terraform apply` / `aws` / `docker push` run by hand — the pipeline owns deployment.

### 3.1 Entity — `product`

Partition key `id` (string, server-generated UUID). Stored shape:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | **hash key**; server-generated |
| `name` | string | required, 1–200 chars |
| `description` | string | optional, ≤ 2000 chars |
| `price` | number | required, ≥ 0, rounded to 2dp |
| `category` | string | required, 1–60 chars (e.g. `Electronics`) |
| `imageUrl` | string | optional; must be `http(s)://…` if present |
| `stock` | integer | optional on create (default `0`), ≥ 0 |
| `rating` | number | optional on create (default `0`), 0–5 |
| `createdAt` | string | **server-set** ISO-8601 |
| `updatedAt` | string | **server-set** ISO-8601 on every write |

### 3.2 Routes (all under the `/products*` ALB route)

| Method | Path | Behaviour |
| --- | --- | --- |
| `GET` | `/health` | 200, plain text, **DB-free** — ALB target-group check (not externally routed) |
| `GET` | `/products` | List, newest `createdAt` first. `?category=` exact-match filter; `?q=` case-insensitive substring match on `name` + `description`; both combinable (see §9 on `Scan`) |
| `GET` | `/products/:id` | One product; `404` if unknown |
| `POST` | `/products` | Create. Validates per §3.1. Server sets `id`/`createdAt`/`updatedAt`. → `201` + the product; `400` on invalid body |
| `PATCH` | `/products/:id` | Partial update of `name`/`description`/`price`/`category`/`imageUrl`/`rating`. Same field validation; ignores client-sent `id`/`createdAt`/`stock`. → `200`; `400` on invalid body or empty patch; `404` if unknown |
| `PATCH` | `/products/:id/stock` | Adjust stock by `{ "delta": <integer> }`. Atomic conditional `UpdateItem`: applies only if the result stays ≥ 0. → `200` with new stock; `400` on a non-integer/absent delta; `404` if unknown; **`409` if it would go negative** |
| `DELETE` | `/products/:id` | Remove a product. → `204`; `404` if unknown |
| `OPTIONS` | `/products*` | CORS preflight → `204` |

Repeated query params (`?category=a&category=b`) are rejected with **400** before any DynamoDB call — the same guard the order service needed.

### 3.3 Frontend screens

| Route | Screen |
| --- | --- |
| `/products` | Catalog grid: name, image, price, category, stock/"Out of stock", rating. Category dropdown + search box (both drive the API query params, not client-side filtering). Link into detail. |
| `/products/:id` | Detail: full description, image, price, category, stock, rating, plus edit / delete / stock-adjust actions. |

Plus a create form on the catalog page. All calls go through the existing `apiFetch` runtime-config seam — no ALB DNS name in source (contract §1, CI-enforced).

## 4. Success criteria

Each is checkable by a command in §8.

1. `npm test` in `services/product/` passes with **no AWS credentials**, covering: `/health` 200; create → read round-trip; `400` on each invalid field (missing `name`, negative `price`, bad `imageUrl`, `rating` > 5, non-integer `stock`); `404` on unknown id for GET/PATCH/DELETE; server-owned fields not trusted from the body (a `POST` carrying `id`, `createdAt` still gets server values); `?category=`/`?q=` filtering; **`409` when a stock delta would go negative**; `409` on a concurrent-stock `ConditionalCheckFailedException`; `400` on a repeated query param.
2. `docker build services/product/` succeeds and the image runs as **non-root** (`docker run --rm --entrypoint id soa-product:test` reports uid ≠ 0).
3. `grep -rn "elb\.amazonaws\.com\|dynamodb\.us-" services/product/src frontend/src` returns **no matches**.
4. `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` both pass; `fmt -check` clean in both.
5. `terraform -chdir=terraform/app-edge plan` shows the product resources as **creates, 0 destroys** — the deployed `order` service is not replaced or modified.
6. Listener rule priority **110** appears exactly once in `app-edge/main.tf`, and `100` (order) is untouched.
7. The `product` task role in the plan carries **`soa-boundary`** and its DynamoDB policy scopes to `soa-product` (+ `/index/*`) **only** — no `*` resource, no AWS-managed or inline policy.
8. Frontend `npm run typecheck` and `npm run build` are clean; no bare `fetch(` outside `lib/api.ts`.
9. After merge, CD is green and `curl -s -o /dev/null -w '%{http_code}' http://<alb-dns>/products` returns **200** (ALB DNS from `terraform output`, never hardcoded).
10. Live round-trip: `POST /products` → `201`; `GET /products?category=…` → contains it; `PATCH /products/:id/stock {"delta":-1}` → `200`; the same call repeated past zero → `409`; `DELETE /products/:id` → `204`; `GET` it again → `404`.
11. `docs/action_plan/README.md` gains a `product/` group listing this PRD, and the order service remains untouched by this change.

## 5. Resources

**AWS resources created** (all via existing shared modules — no new module is written):

| Resource | Terraform type | Config | Cost |
| --- | --- | --- | --- |
| `soa-product` DynamoDB table | `aws_dynamodb_table` (via `modules/data`) | `app-base` | **Free tier** — PAY_PER_REQUEST, 25 GB free; demo traffic ~$0. Permanent |
| `soa-product` ECR repo | `aws_ecr_repository` (via `modules/ecs-service`) | `app-edge` | **Free tier** — 500 MB/mo private storage |
| `soa-product` ECS service + task definition | `aws_ecs_service`, `aws_ecs_task_definition` | `app-edge` | **Billable** — 1 Fargate task @ 256 CPU / 512 MiB ≈ **$0.012/hr ≈ $9/mo if left running**. Dies on `terraform destroy` of `app-edge` |
| `soa-product` target group + listener rule | `aws_lb_target_group`, `aws_lb_listener_rule` | `app-edge` | **Free** — attaches to the existing shared ALB; no new ALB |
| `soa-product` task role + `soa-product-task` policy | `aws_iam_role`, `aws_iam_policy` | `app-edge` | **Free** |
| `soa-product` task security group | `aws_security_group` | `app-edge` | **Free** |
| `/ecs/soa-product` log group | `aws_cloudwatch_log_group` | `app-edge` | **Free tier** — 5 GB ingest/mo |
| Autoscaling target + policy | `aws_appautoscaling_*` | `app-edge` | **Free** (scaling *out* adds task cost) |

**Net new cost:** ~**$9/mo** of Fargate *while `app-edge` is up*, doubling the current Fargate line (order + product = ~$18/mo) on top of the existing ~$16/mo ALB. Everything returns to **$0** on the routine `app-edge` teardown ([cost-lifecycle.md](../../operations/cost-lifecycle.md)). Nothing permanent and billable is added.

**Repo files touched:**

- **New:** `services/product/` (`src/app.js`, `src/index.js`, `src/products.js`, `Dockerfile`, `package.json`, `.dockerignore`, `.gitignore`, `README.md`, `tests/`); `frontend/src/features/products/ProductDetailPage.tsx`.
- **Edited:** [`terraform/app-base/main.tf`](../../../terraform/app-base/main.tf) (+`module "product_table"`), [`terraform/app-edge/main.tf`](../../../terraform/app-edge/main.tf) (+`module "product_service"`), [`docker-compose.yml`](../../../docker-compose.yml) (+`product` block), `frontend/src/features/products/{api.ts,ProductsPage.tsx}` (stub → real), `frontend/src/router.tsx` + `Layout.tsx` (detail route + nav link), [`docs/action_plan/README.md`](../README.md) (index line), [`docs/architecture/overview.md`](../../architecture/overview.md) (second service).
- **Not touched:** `services/_template/`, `services/order/`, `terraform/modules/*`, `terraform/` root identity config, the workflows.

**Derived infrastructure** (from the [service contract](../../../.claude/rules/service-contract.md), no decision needed):

| | |
| --- | --- |
| Service folder | `services/product/` |
| AWS names | `soa-product` |
| Table | `soa-product`, hash key `id` |
| Env var | `PRODUCT_TABLE` = `${var.name_prefix}-product` |
| Other env | `PORT=3000`, `CORS_ALLOWED_ORIGIN` |
| ALB route | `/products*` |
| Listener priority | **110** (order holds 100; next service takes 120) |
| Port | 3000 |

**External references:** [DynamoDB `Scan` FilterExpression](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html), [conditional `UpdateItem`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html#WorkingWithItems.ConditionalUpdate), [`@aws-sdk/lib-dynamodb`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-dynamodb/).

## 6. Scripts / commands

Run locally by the agents — **nothing billable, nothing that touches AWS state**:

```bash
# 1. Scaffold + implement (app-engineer)
cp -r services/_template services/product        # then replace the three tokens
cd services/product && npm install && npm test

# 2. Local integration against DynamoDB Local
docker compose up -d dynamodb-local
docker compose up --build product
curl -s localhost:3001/health
docker compose down

# 3. Image check
docker build -t soa-product:test services/product
docker run --rm --entrypoint id soa-product:test   # must NOT be uid=0

# 4. Frontend
cd frontend && npm run typecheck && npm run build

# 5. Terraform (terraform-engineer) — validate/plan ONLY, never apply
terraform -chdir=terraform/app-base fmt -check && terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge fmt -check && terraform -chdir=terraform/app-edge validate
terraform -chdir=terraform/app-edge plan          # read-only; expect creates, 0 destroys

# 6. Contract grep
grep -rn "elb\.amazonaws\.com" services/product/src frontend/src   # must be empty

# 7. PR
git checkout -b feat/product-service && git commit && git push && gh pr create
```

**Billable / destructive commands run by the pipeline, not by hand:**

- `cd.yml` → `terraform -chdir=terraform/app-base apply -auto-approve` — **creates the `soa-product` table**.
- `cd.yml` → `docker build` + `docker push` of `soa-product:$GITHUB_SHA` to ECR.
- `cd.yml` → `terraform -chdir=terraform/app-edge apply -auto-approve` — **creates the billable ECS service**.
- `cd.yml` → `aws ecs wait services-stable`.

**No `terraform apply`, `terraform destroy`, `aws`, or `docker push` is run from this session.**

**Deployment is fully self-serve.** On merge, `cd.yml` applies `app-base` (creating `soa-product`), discovers `services/product` under `services/*`, builds and pushes `soa-product:$GITHUB_SHA`, applies `app-edge`, and waits for the service to stabilize. The pipeline **can** create the table but is explicitly **denied `dynamodb:DeleteTable`** and has **no data-plane access** ([ADR 0003](../../architecture/decisions/0003-base-edge-split.md)).

## 7. Planned agents

| Step | Agent | Hands off |
| --- | --- | --- |
| 1. Scaffold `services/product/` from `_template`, replace tokens, implement §3.1/§3.2 (entity, routes, validation, atomic stock, CORS), write tests, add the `docker-compose.yml` block, run `npm test` | **`app-engineer`** | A green, containerized service meeting the contract |
| 2. Add the two module blocks (`product_table` in `app-base`, `product_service` in `app-edge`, priority 110), run `fmt`/`validate` | **`terraform-engineer`** | Two validated Terraform diffs, no new modules |
| 3. Replace the frontend product stub with the catalog + detail screens and real types; `typecheck` + `build` | **`app-engineer`** | Working SPA screens over `apiFetch` |
| 4. Audit the Terraform diff: boundary on the task role, table-scoped policy, unique priority 110, no billable surprises, order service untouched | **`infra-reviewer`** | Review findings before the PR |
| 5. Index line in `docs/action_plan/README.md`, cross-links, `docs/architecture/overview.md` refresh to name product as the second service | **`documentation-keeper`** | Consistent docs |
| 6. PRD authoring, orchestration, branch + PR, Outcome note | **main session** | This PRD, the PR |

## 8. Testing / verification plan

| §4 | Verification |
| --- | --- |
| 1 | `cd services/product && npm test` — assert every listed case, including a `POST` carrying `{"id":"attacker","createdAt":"1999-01-01"}` that still stores server values, and a mocked `ConditionalCheckFailedException` on the stock route mapping to 409 (not 500) |
| 2 | `docker build -t soa-product:test services/product` then `docker run --rm --entrypoint id soa-product:test` → uid ≠ 0 |
| 3 | `grep -rn "elb\.amazonaws\.com\|dynamodb\.us-" services/product/src frontend/src` → no output |
| 4 | `terraform -chdir=terraform/app-base fmt -check && validate`; same for `app-edge` → exit 0 |
| 5 | `terraform -chdir=terraform/app-edge plan` → summary line reads `0 to destroy`; grep the plan for `module.order_service` → no changes |
| 6 | `grep -n "priority" terraform/app-edge/main.tf` → `100` once, `110` once |
| 7 | **`infra-reviewer` pass** over the diff + plan: `permissions_boundary` set, policy `Resource` lists only the `soa-product` ARN + `/index/*`, customer-managed `soa-*` policy |
| 8 | `cd frontend && npm run typecheck && npm run build`; `grep -rn "fetch(" frontend/src --include=*.tsx --include=*.ts \| grep -v lib/api.ts` → empty |
| 9 | Post-merge: `ALB=$(terraform -chdir=terraform/app-edge output -raw alb_dns_name)` then `curl -s -o /dev/null -w '%{http_code}' "http://$ALB/products"` → `200` |
| 10 | Post-merge smoke sequence in §4.10, run against `$ALB`; also confirm `GET /orders` still returns 200 (no regression on the existing service) |
| 11 | Read `docs/action_plan/README.md` |

Plus the automatic gates: `ci.yml` discovers `services/product`, builds it, and plans both configs as `soa-ci-plan`; branch protection blocks merge until green. `/ecs/soa-product` in CloudWatch Logs is checked after the first deploy for clean startup.

## 9. Additional considerations

**`Scan` instead of a `category` GSI.** Same limitation the order service carries: the shared `data` module creates a hash-key-only table, so `?category=` and `?q=` are a `Scan` with a `FilterExpression`, and `?q=` is a substring match done in the filter, not a real search index. At course-demo scale (tens of products) this is correct and free; at real scale it is not. Adding a GSI means extending the `data` module — a platform change, so a **follow-up PRD**, not smuggled in here. Documented in the service README.

**Unauthenticated writes are a real gap, accepted knowingly.** Unlike orders (where the exposure is reading someone else's data), the product service exposes `POST`/`PATCH`/`DELETE` to anyone who can reach the ALB — a caller can delete the whole catalog. This is the same deferred-auth posture as [ADR 0004](../../architecture/decisions/0004-frontend-hosting.md), acceptable for a disposable course demo with no real data, and it lands with the HTTPS/Cognito PRD. Stated here rather than left implied. **Do not put real data in this demo.**

**Stock races.** `PATCH /products/:id/stock` uses a single conditional `UpdateItem` (`ADD stock :delta` with `ConditionExpression: stock >= :minRequired`) rather than a read-then-write, so two concurrent decrements cannot both succeed past zero. This is the fix the order service had to retrofit; doing it up front here.

**Rollback / teardown.** The ECS service, target group, listener rule, task role, SG, log group and ECR repo live in `app-edge` and vanish on the routine `terraform destroy`. The **`soa-product` table lives in `app-base` and survives** — the pipeline can create/update it but is denied `dynamodb:DeleteTable` and has no data-plane access. A bad deploy rolls back by redeploying the previous SHA-tagged task definition; a failed ALB health check stops the rollout on the last good task set.

**Security posture.** One more least-privilege task role scoped to one table, carrying `soa-boundary` — the same shape order proved. One additional path rule on the existing ALB; the task SG accepts port 3000 from the ALB SG only. No secrets introduced (`PRODUCT_TABLE`, `CORS_ALLOWED_ORIGIN` are non-sensitive).

**Deployer permissions should not be a risk this time.** Order was the first-ever `ecs-service` instantiation and exposed the `AccessDenied` friction; product instantiates the identical module with identical resource types, so the deployer grants are already proven. If something does deny, the fix is a human apply on the root identity config, not a looser boundary ([compute-layer.md §5](../../operations/compute-layer.md#5-deployer-permissions-grows-with-new-resource-types)).

**Local port collision.** `order` already binds host port 3000 in `docker-compose.yml`; the `product` block maps host `3001` → container `3000` so both run locally at once.

**Follow-ups this PRD deliberately leaves open:** `order/0002` (order → product sync call + stock decrement, the rubric's service-to-service point), `platform/0008` (SQS→Lambda→SNS async path, the rubric's async requirement), a `category` GSI, and auth.

---

## Outcome

**Executed as planned — both halves in one PR.** 2026-07-27. Branch `feat/product-service`, commit `caa8039`. Status stays **In Progress** until CD is green and §4.9–§4.10 are verified against the live ALB.

### What was built

`services/product/`, scaffolded from `_template` with all three tokens replaced, implementing every route and rule in §3.2:

- `src/products.js` — pure domain logic (field validation, `buildProductFromInput`, `buildProductPatch`, `isValidStockDelta`), no HTTP or AWS imports.
- `src/app.js` — Express: `/health` (left DB-free, untouched from the template), the seven product routes, and the env-driven CORS middleware copied from `order` (no `cors` dependency added).
- `tests/` — 3 suites, **73 tests, all passing** with no AWS credentials, DynamoDB mocked via a Jest module mock.
- `README.md` documenting routes, env vars, local run, and both known limitations.
- `docker-compose.yml` — a `product` block on host port **3001** (order holds 3000).

**Terraform, written in this PR** (unlike order/0001, which handed its blocks off and consequently red-built `main`): `module "product_table"` in `app-base`, `module "product_service"` in `app-edge` at priority 110. Both call existing shared modules; `terraform/modules/*` and the order blocks are untouched.

**Frontend:** the placeholder stub in `frontend/src/features/products/` became a real catalog page (server-side `?category=`/`?q=` filtering), a new `ProductDetailPage.tsx`, and full create/edit/delete/stock-adjust actions, all through `apiFetch`.

### Deviations from plan

All three are minor and were flagged rather than silently taken:

1. **`?q=` is filtered in-app, after the `Scan`, not in the `FilterExpression`.** DynamoDB has no case-insensitive `contains` operator, so a literal reading of §3.2 was not implementable. `?category=` *is* pushed down as a `FilterExpression`. Consistent with §9's Scan-not-GSI framing and documented in the service README.
2. **`PATCH /products/:id` uses one conditional `UpdateItem` with `ReturnValues: ALL_NEW`** rather than order's Get-then-Update. Stricter and one round trip cheaper; the condition failure alone distinguishes 404, so the two-call disambiguation §3.2 asks for is needed only on the stock route.
3. **`frontend/src/lib/api.ts` gained `ApiError.body` + an `errorMessage()` helper** — not named in §5's file list. Required to satisfy §3.3's "surface the 409 readably"; the alternative was parsing raw JSON out of `error.message` in each page. Purely additive; the orders feature is unaffected.

Also worth noting: the category dropdown is populated by a **second, unfiltered** `useProducts()` call. Deriving it from the filtered list would collapse the dropdown to one option once a category is picked, trapping the user. Two GETs is an acceptable trade at the demo scale §9 assumes.

### Success criteria status

| Criterion | Result |
| --- | --- |
| §4.1 `npm test`, no AWS creds | **Met** — 73/73 pass, incl. the attacker-payload and 409-not-500 condition-failure cases |
| §4.2 non-root image | **Not verified** — Docker unavailable in this environment. The `Dockerfile` is byte-identical to the deployed order one (`USER node`), so it should hold, but it was not observed |
| §4.3 no hardcoded endpoints | **Met** — grep clean over `services/product/src` and `frontend/src` |
| §4.4 `fmt`/`validate` both configs | **Not verified locally** — Terraform is not installed here. Falls to CI's `soa-ci-plan` run |
| §4.5 plan shows creates, 0 destroys | **Not verified locally** — same reason; CI must confirm |
| §4.6 priority 110 unique | **Met** — `100` and `110` each appear exactly once as live declarations in `app-edge/main.tf` |
| §4.7 boundary + table-scoped role | **Met** — `infra-reviewer` traced it through `modules/ecs-service`: `permissions_boundary` set, customer-managed `soa-product-task` policy scoped to the constructed table ARN + `/index/*` only |
| §4.8 frontend typecheck + build | **Met** — both clean; no bare `fetch(` outside `lib/api.ts` |
| §4.9 `curl /products` → 200 | **Pending merge** — not deployed yet |
| §4.10 live round-trip | **Pending merge** |
| §4.11 index line, order untouched | **Met** — order blocks byte-for-byte unchanged |

### Review pass

`infra-reviewer` audited the full diff and returned **no blockers and no should-fix findings**. It verified character-by-character that the table name created by `app-base` (`${var.name_prefix}-product`), the injected `PRODUCT_TABLE` env value, and the `table_arns` string all match — a mismatch there would deploy a service that passes its health check and 500s on every real request. It also confirmed the stock route's `ConditionExpression` (`stock >= :minRequired` where `minRequired = -delta`) genuinely prevents overselling under concurrency, and that a non-condition SDK error short-circuits to 500 before the 404/409 disambiguation read ever runs.

### Still owed after merge (§4.9–§4.10)

```bash
ALB=$(terraform -chdir=terraform/app-edge output -raw alb_dns_name)
curl -s -o /dev/null -w '%{http_code}\n' "http://$ALB/products"   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' "http://$ALB/orders"     # expect 200 — no regression

ID=$(curl -s -XPOST "http://$ALB/products" -H 'content-type: application/json' \
  -d '{"name":"Echo Dot","price":49.99,"category":"Electronics","stock":1}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["id"])')

curl -s -XPATCH "http://$ALB/products/$ID/stock" -H 'content-type: application/json' -d '{"delta":-1}'  # 200, stock 0
curl -s -o /dev/null -w '%{http_code}\n' -XPATCH "http://$ALB/products/$ID/stock" \
  -H 'content-type: application/json' -d '{"delta":-1}'           # expect 409
curl -s -o /dev/null -w '%{http_code}\n' -XDELETE "http://$ALB/products/$ID"   # expect 204
```

Or just open the SPA's Products page and use the create form and the ± stock buttons.

### Follow-ups

- `order/0002` — order → product sync call + stock decrement (the rubric's service-to-service point).
- `platform/0008` — the SQS→Lambda→SNS async path (rubric-required, still unbuilt; `functions/` does not exist).
- A `category` GSI (needs the shared `data` module extended) and auth, both deferred as designed.
