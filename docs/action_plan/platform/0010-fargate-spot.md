# 0010 — Fargate Spot for ECS Services (compute cost reduction)

> Run the ECS services on **Fargate Spot** instead of on-demand Fargate — ~70% cheaper compute for the same tasks — while keeping all infrastructure standing (ALB, services, routes, tables, Cognito untouched). Accepts occasional Spot interruptions (2-min warning, ECS auto-reschedules). Reversible via a single toggle. No teardown.

## 1. Status & metadata

- **Status:** In Progress
- **Date:** 2026-07-28
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-28 (user)

## 2. User story

As the platform owner running a multi-week demo, I want the running microservices to use Fargate Spot so that compute cost drops ~70% (from ~$18.70 to ~$5.60 per 3 weeks across the three services) **without tearing down any infrastructure or reducing availability** — the ALB, services, DNS, DynamoDB data, and Cognito all stay live, and the only trade is rare, self-healing Spot interruptions.

## 3. Scope

**In scope** (two coordinated Terraform changes):
- **`terraform/modules/ecs-cluster/` (in `app-base`):** add an `aws_ecs_cluster_capacity_providers` resource associating **`FARGATE`** and **`FARGATE_SPOT`** with `soa-cluster` (required before any service can request Spot). Keep `FARGATE` available so a flip back to on-demand needs no cluster change.
- **`terraform/modules/ecs-service/` (in `app-edge`):** replace `launch_type = "FARGATE"` on `aws_ecs_service` with a `capacity_provider_strategy` block targeting **`FARGATE_SPOT`** (weight 1), gated behind a new **`use_fargate_spot`** variable (default `true`) so any service can be flipped back to on-demand with a one-line change. `requires_compatibilities = ["FARGATE"]` on the task definition is unchanged (Spot is still Fargate).
- Applies to **all three services** (order, product, user) on the next CD run — each gets one rolling redeploy onto Spot.

**Out of scope:**
- **On-demand base + Spot mix** — each service runs a single task, so it can't split one task across an on-demand base *and* Spot; it's pure Spot or pure on-demand. (If a service later runs ≥2 tasks, a base/Spot split becomes possible — a future tweak.)
- **Autoscaling changes** — min/max and the CPU target policy stay as-is; Spot tasks autoscale the same way.
- **Scheduled scale-down / scale-to-zero** — a separate cost lever, not this PRD.
- **The ALB and public-IPv4 costs** — fixed while the edge is up; unaffected by this change.

## 4. Success criteria

1. `terraform -chdir=terraform/app-base validate` and `terraform -chdir=terraform/app-edge validate` pass.
2. `soa-cluster` has both capacity providers: `aws ecs describe-clusters --clusters soa-cluster` (or `describe-capacity-providers`) shows `FARGATE` + `FARGATE_SPOT` associated.
3. After CD, each service runs on Spot: `aws ecs describe-services --services soa-order soa-product soa-user` shows `capacityProviderStrategy` = `FARGATE_SPOT` (and no `launchType: FARGATE`).
4. All three services stay **healthy 1/1** post-redeploy; `GET /orders` and `GET /products` → 200 (no availability regression from the capacity-provider swap itself).
5. `infra-reviewer` confirms: no new billable resource (the capacity-providers association is free), keyless CI/CD intact, the change is reversible via `use_fargate_spot`.
6. Compute cost drops — the Fargate line for the 3 tasks falls ~70% (verifiable on the next Cost Explorer / billing view).

## 5. Resources

| Resource | Type | Cost |
| --- | --- | --- |
| Cluster capacity-providers association | `aws_ecs_cluster_capacity_providers` | **$0** |
| Service capacity-provider strategy | `aws_ecs_service` change (no new resource) | **reduces** Fargate ~70% |
| `use_fargate_spot` variable | Terraform var (default true) | **$0** |

**Cost impact:** a **reduction** — ~$18.70 → ~$5.60 Fargate per 3 weeks (3 tasks), no new billable resource. ALB + public IPv4 unchanged.

## 6. Scripts / commands

```bash
# Validate (terraform-engineer; no apply)
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge validate

# Ship it (self-serve: PR -> CI -> merge -> CD applies base then edge, redeploys services on Spot)
git checkout -b fargate-spot
git add -A && git commit -m "Run ECS services on Fargate Spot (PRD platform/0010)"
git push -u origin fargate-spot

# Verify after CD
aws ecs describe-services --cluster soa-cluster --services soa-order soa-product soa-user \
  --query 'services[].[serviceName,capacityProviderStrategy[0].capacityProvider,runningCount]' --output text
```

No destructive command — this is a rolling redeploy of existing services onto Spot capacity.

## 7. Planned agents

- **`terraform-engineer`** — add `aws_ecs_cluster_capacity_providers` to the `ecs-cluster` module; add the `use_fargate_spot` variable + `capacity_provider_strategy` (replacing `launch_type`) to the `ecs-service` module. `fmt`/`validate` both configs; never apply.
- **`infra-reviewer`** — confirm the capacity-provider wiring is correct, the change is free + reversible, keyless CI/CD and the base/edge boundary are intact, and no service loses its boundary/table scoping.
- **CD pipeline** — applies `app-base` (cluster capacity providers) then `app-edge` (services redeploy onto Spot) on merge; no manual step.
- **Main session** — writes this PRD, drives the PR + post-deploy verification.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 validate | `validate` both configs |
| #2 cluster CPs | `aws ecs describe-clusters`/`describe-capacity-providers` shows FARGATE + FARGATE_SPOT |
| #3 services on Spot | `aws ecs describe-services … capacityProviderStrategy` = FARGATE_SPOT |
| #4 healthy | `runningCount` 1/1 each; `GET /orders`,`/products` → 200 |
| #5 review | `infra-reviewer` verdict (free, reversible, keyless) |
| #6 cost | Fargate line drops ~70% on next billing view |

## 9. Additional considerations

- **The trade — Spot interruptions:** AWS can reclaim Spot capacity with a 2-minute warning; ECS drains and reschedules the task automatically, so a service may see a brief blip (~30–60s) before a replacement task is healthy. Fine for a demo, not for production SLAs — hence the `use_fargate_spot` toggle to revert instantly.
- **Reversible:** set `use_fargate_spot = false` (per service or default) → back to on-demand `FARGATE`, no cluster change needed (both providers stay associated). One PR.
- **One-time forced service replacement (not a seamless rolling deploy):** switching `launch_type` → `capacity_provider_strategy` is a **ForceNew** on `aws_ecs_service` — Terraform destroys and recreates each service resource (not just swapping tasks within it). So on **this one deploy**, each service has a brief full gap (~1–3 min, 503 on its route) between destroy and create, because the target group has no registered service in between. It's one-time (subsequent deploys are normal rolling), stateless/data-safe (tables, task roles, boundary untouched), and best merged at a quiet moment rather than mid-demo. `create_before_destroy` can't avoid it here — two services can't share the fixed `soa-<name>` name.
- **Survives teardown:** the cluster capacity-provider association lives in `app-base` (permanent); the service strategy in `app-edge` (recreated each spin-up already carrying Spot). No interaction with the destroy-to-$0 cycle.
- **Not a fit for future prod:** if any service becomes latency/uptime-critical, give it `use_fargate_spot = false` (or a base-on-demand + Spot mix once it runs ≥2 tasks).

---

## Outcome

_Filled after execution._
