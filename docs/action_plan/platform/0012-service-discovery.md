# 0012 — Service Discovery (ECS Service Connect + order→product)

> Satisfy the rubric's service-discovery requirement with **ECS Service Connect**: an HTTP namespace on the cluster, Service Connect enabled on all three services (discoverable by logical name), and one real **order → product** inter-service call on order placement to exercise it. Least-privilege SG scoping, no hardcoded endpoints, base/edge split respected, Fargate-Spot-compatible. Service Connect/Cloud Map are free; a possible small task-memory bump for the sidecar is the only cost.

## 1. Status & metadata

- **Status:** In Progress
- **Date:** 2026-07-28
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-28 (user)

> Decisions settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the team, we want internal service-to-service discovery — services finding each other by a stable logical name rather than a moving IP or the public ALB — demonstrated by a real order→product call, so that the project meets the rubric's "ECS Service Connect / AWS Cloud Map" requirement and shows genuine microservice interaction.

## 3. Scope

**In scope:**
- **ECS Service Connect enablement** (all 3 services):
  - **`app-base`:** an `aws_service_discovery_http_namespace` named `soa` (permanent, alongside the cluster). Export its ARN as an output for `app-edge`.
  - **`ecs-service` module (`app-edge`):** add a `service_connect_configuration` to each `aws_ecs_service` — join the `soa` namespace, and (for the server side) advertise the app port under the service's logical name (`order`/`product`/`user`) so peers call `http://<name>:3000`. Enabled uniformly for all services (a new service inherits it).
- **The order → product call** (exercises discovery):
  - `services/order`: on `POST /orders`, for each line item, `GET http://product:3000/products/:id` (base URL from injected env `PRODUCT_SERVICE_URL`). **Read-only** validation: `404` → reject the order (`4xx`, unknown product); product unreachable/`5xx` after Service Connect's retries → **`503` fail-closed**; `200` → continue and save the order. No stock write.
  - `services/product`: no change — `GET /products/:id` already exists.
- **Shared-mesh SG (user's choice):** a single internal "mesh" security group created once in `app-base` (permanent, with the cluster) that **every** service's task attaches to (alongside its existing ALB-scoped task SG), allowing ingress from **itself** on the app port (3000). Any service can then reach any service internally, with no per-pair wiring, and a future `/new-service` needs nothing. The `ecs-service` module takes the mesh SG id as an input and adds it to the task's `network_configuration.security_groups`. Trade vs. per-caller: broader than strict least-privilege (any task↔any task on 3000) — but still **only within the cluster's tasks** (the mesh SG only trusts itself; the internet/ALB path is unchanged).
- **Env seam:** `app-edge` injects `PRODUCT_SERVICE_URL = "http://product:3000"` into the order service (no hardcoded endpoint; the Service Connect logical name is the stable address).
- **Contract + factory:** `service-contract.md` documents inter-service calls via Service Connect logical names (still "no hardcoded endpoints"); `/new-service` notes services are Service-Connect-enabled by default and how to add a peer call.
- **Docs:** an ADR recording the Service Connect decision; update `overview.md` (the service-interaction diagram gains the order→product edge); `adding-a-service.md`.
- **Testing:** order unit tests mock the product call (404/5xx/ok branches); a **CD smoke test** places an order for a seeded product (succeeds) and a bogus id (rejected) against the live services.

**Out of scope:**
- Stock decrement / any cross-service **write** (distributed-transaction territory — deferred).
- order→user or product→* calls (the user service is Cognito-auth-gated; one call suffices for the rubric).
- Replacing the ALB — external routing stays ALB path-based; this adds *internal* discovery only.
- A service mesh beyond Service Connect (App Mesh, etc.).

## 4. Success criteria

1. `aws_service_discovery_http_namespace` `soa` exists (app-base); all three ECS services show a `serviceConnectConfiguration` enabled in the `soa` namespace (`aws ecs describe-services`).
2. `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` pass; all services stay **healthy** after the rollout (Service Connect sidecar running).
3. **Discovery works end-to-end:** `POST /orders` for a **real** product succeeds (order saved); the order service's logs/behavior show it reached `http://product:3000`. `POST /orders` for a **nonexistent** product id is rejected (`4xx`). With product scaled to 0 (or unreachable), a placement returns **`503`** (fail-closed).
4. **Shared-mesh SG:** every service's task attaches the internal mesh SG, which allows ingress **only from itself** on port 3000 (each task also keeps its ALB-scoped SG for the public path). Nothing outside the cluster's tasks can reach a service internally; `infra-reviewer` confirms the mesh SG trusts only itself.
5. **No hardcoded endpoints:** the order service reads `PRODUCT_SERVICE_URL` from env; grep finds no literal `product:3000`/ALB DNS in source; CI's no-hardcoded-endpoint check passes.
6. Order unit tests cover the 404/5xx/ok branches (mocked); the CD smoke test proves the live path.
7. Cost impact confirmed minor: Service Connect/namespace free; any task-memory bump for the sidecar is quantified and small; Fargate Spot still works.

## 5. Resources

| Resource | Type | Cost |
| --- | --- | --- |
| `soa` HTTP namespace | `aws_service_discovery_http_namespace` | **$0** |
| Per-service Service Connect config | `aws_ecs_service.service_connect_configuration` | **$0** (managed Envoy sidecar; small task CPU/mem) |
| SG peer-ingress rule | `aws_security_group` ingress (module) | **$0** |
| Possible task memory bump (512→1024) | `ecs-service` cpu/memory | **~$1–5/mo** across 3 tasks if needed (less on Spot) |
| order service call + tests | app code | **$0** |

**Total: ~$0–$5/mo.** Service Connect and the namespace are free; the only possible cost is a modest Fargate memory bump if the Envoy sidecar doesn't fit in 0.5 GB alongside the Node app — quantified during implementation.

## 6. Scripts / commands

```bash
# Local
cd services/order && npm ci && npm test        # incl. mocked product-call branches
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge validate

# Ship (self-serve: PR -> CI -> merge -> CD applies app-base then app-edge)
git checkout -b service-discovery
# ... commit ...
# CD: app-base (namespace) -> app-edge (Service Connect on services + SG + env) -> smoke test

# Verify live
aws ecs describe-services --cluster soa-cluster --services soa-order soa-product soa-user \
  --query 'services[].[serviceName,serviceConnectConfiguration.enabled]' --output text
ALB=<alb dns>
curl -s -X POST http://$ALB/orders -d '{...valid product...}'   # 2xx
curl -s -X POST http://$ALB/orders -d '{...bogus productId...}' # 4xx
```

No manual/destructive step — deploys via CD (base then edge).

## 7. Planned agents

- **`terraform-engineer`** — `soa` HTTP namespace + a shared internal **mesh SG** (self-ingress on 3000) + their outputs (app-base); `service_connect_configuration` on the `ecs-service` module (all services) + attach the mesh SG to each task's `network_configuration` + inject `PRODUCT_SERVICE_URL` into order (app-edge); size the sidecar (bump task memory only if required, quantify it). `fmt`/`validate`; never apply.
- **`app-engineer`** — order service: the product-validation call on `POST /orders` (read `PRODUCT_SERVICE_URL`; per-item `GET /products/:id`; 404→reject / 5xx→503 / ok→place; short timeout) + unit tests mocking the branches. Confirm product needs no change.
- **`pipeline-engineer`** — CD smoke test for the order→product path (seed a product, place a valid + a bogus order, assert).
- **`infra-reviewer`** — SG least-privilege (product accepts order + ALB only), namespace/base-edge placement, no hardcoded endpoint, Fargate Spot compatibility, cost of any memory bump.
- **`documentation-keeper`** — ADR (Service Connect decision); `overview.md` interaction diagram (+order→product edge); `adding-a-service.md`.
- **Main session** — this PRD; `service-contract.md` + `/new-service` updates (inter-service calls via Service Connect names).

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 SC enabled | `aws ecs describe-services … serviceConnectConfiguration`; namespace exists |
| #2 validate/healthy | `validate` both; `ecs wait services-stable` after rollout |
| #3 discovery works | live `curl` POST valid (2xx) + bogus (4xx); product@0 → 503 |
| #4 SG least-priv | `infra-reviewer` + `aws ec2 describe-security-groups` on product's task SG |
| #5 no hardcode | grep `services/order/src`; CI check green |
| #6 tests | `npm test` (order) covers branches; CD smoke test green |
| #7 cost | confirm namespace/SC free; state any memory bump + $ |

## 9. Additional considerations

- **The Envoy sidecar** is what makes discovery robust (retries, live endpoint tracking, CloudWatch connection metrics) but consumes some task CPU/mem. On 0.25 vCPU / 0.5 GB, verify the Node app + sidecar fit; bump to 1 GB only if needed (quantified). Fargate Spot is unaffected.
- **Fail-closed coupling:** order now depends on product being reachable to place an order. This is the intended demonstration; Service Connect retries absorb transient blips, and it's a demo (not a prod SLA). Documented as a deliberate trade.
- **Still no hardcoded endpoints:** the logical name `http://product:3000` is a *stable* Service-Connect address, injected via env — it does not churn like the ALB DNS and is not a literal external endpoint. The no-hardcoded-endpoint rule is preserved (read from `PRODUCT_SERVICE_URL`).
- **Rollout:** changing a service to add `service_connect_configuration` triggers an ECS rolling deploy per service (health-checked); one-time, no data impact. CD applies base (namespace) before edge (services reference it).
- **Rollback:** remove `service_connect_configuration` (+ the order call) — reversible; the namespace is free to leave standing.

---

## Outcome

_Filled after execution._
