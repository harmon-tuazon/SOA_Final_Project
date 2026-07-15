# Cost Lifecycle: Teardown & Spin-Up

How to take the billable edge down to ~$0 between work sessions and bring it back up, without touching the permanent free foundation or losing any service's data. Built by [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md); decision record in [ADR 0003](../architecture/decisions/0003-base-edge-split.md) (why the split exists) and [ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md) (the original identity/app lifecycle split this refines).

Config sources: [`terraform/app-base/`](../../terraform/app-base/) (permanent, free), [`terraform/app-edge/`](../../terraform/app-edge/) (destroyable, billable), shared modules in [`terraform/modules/`](../../terraform/modules/).

## The two lifecycles, in one line each

- **`terraform/app-base/`** — network, ECS cluster, shared execution role, ALB security group, every service's DynamoDB table, and (per [ADR 0004](../architecture/decisions/0004-frontend-hosting.md)) the frontend's S3 website bucket. **Applied by the pipeline, never destroyed.** Entirely free (no ALB, no running tasks in this config).
- **`terraform/app-edge/`** — the shared ALB + HTTP listener, and every service's `ecs-service` module (task def, ECS service, target group, listener rule, autoscaling). **Applied by the pipeline; this is what routine teardown destroys.** The ALB (~$16/mo while it exists) plus any running Fargate tasks are the only billable resources in the whole app tier.

**The frontend is not part of either lifecycle's cost, and not part of the teardown cycle.** The SPA's S3 bucket lives in `app-base` — a few MB of static assets well within the S3 free tier — so it's always-on at ~$0 and, unlike the ALB, its **website endpoint is stable**: it does not change across `app-edge` teardown/spin-up cycles. Only the SPA's *backend API calls* are affected by an `app-edge` teardown (they fail gracefully — see `frontend/src/lib/api.ts`'s "backend unavailable" handling); the site itself keeps loading. See [ADR 0004](../architecture/decisions/0004-frontend-hosting.md) and [adding-a-frontend-feature.md](adding-a-frontend-feature.md).

## One-time: how `app-base` first comes to exist

`app-base` is pipeline-applied like `app-edge`, but it needs to exist *before* `app-edge` can plan (`app-edge` reads `app-base`'s outputs via `terraform_remote_state`). In practice this happens the same way any config does the first time:

1. The one-time, human-applied step is the **identity foundation** (`terraform/` root, `terraform apply` with admin credentials) — the GitHub OIDC provider, `soa-deployer`, `soa-ci-plan`, the `soa-boundary`, and (per PRD platform/0006) the deployer's scoped table create/update grant plus the `DeleteTable`/`DeleteBackup` deny. This is a prerequisite for the pipeline to be able to assume any role at all — see [terraform-foundation.md](terraform-foundation.md).
2. With the identity foundation in place, the **first CD run** that touches `terraform/app-base/**` (or `terraform/app-edge/**`) applies `app-base` — creating the VPC, cluster, execution role, ALB SG, and (if a service PR has landed) its table — with **zero billable resources**.
3. CD then applies `app-edge`, which reads `app-base`'s freshly-created outputs via remote state and stands up the ALB (+ any service compute).

After this first run, `app-base` stays applied and effectively static — later CD runs apply it again (idempotent, usually a no-op) before applying `app-edge`, but nothing in `app-base` normally changes except when a new service's table is added.

## Teardown to ~$0

Routine teardown between sessions targets **`app-edge` only**:

```bash
terraform -chdir=terraform/app-edge destroy
```

This removes the ALB, HTTP listener, and every service's ECS resources (task definitions, services, target groups, listener rules, task roles, autoscaling — but **not** its ECR repo images or DynamoDB table, which live elsewhere). `app-base` is a separate state and is untouched.

**Confirm it worked:**

```bash
# No load balancers left running (empty list / no soa-alb entry)
aws elbv2 describe-load-balancers

# app-base sees no drift — network/cluster/roles/tables are exactly as before
terraform -chdir=terraform/app-base plan
# expect: "No changes. Your infrastructure matches the configuration."
```

If `app-base plan` shows anything other than zero changes after an `app-edge destroy`, that's a signal something in `app-base` was affected — it should never be, since the two configs share no resources, only remote-state *reads*.

## Spin back up

Nothing has to be recreated by hand. Either:

- **Push to `main` / re-run CD** — the next CD run applies `app-base` (a no-op, since nothing there changed) then `app-edge` (recreates the ALB, listener, and every currently-declared service's compute from scratch), or
- **Local apply**, if working outside the pipeline for verification:

  ```bash
  terraform -chdir=terraform/app-edge init -backend-config=backend.hcl
  terraform -chdir=terraform/app-edge apply
  ```

Either way, every service's **data is still in its table** — `app-base` was never touched, so nothing needed to be restored. The only thing that changes on recreation is the **ALB's DNS name** (a new `aws_lb` gets issued a new one each time `app-edge` is recreated) — every consumer reads the API base URL from config/env rather than a hardcoded value, per the [no-hardcoded-endpoint rule](../../.claude/rules/service-contract.md), so this doesn't break anything; get the current DNS name with `terraform -chdir=terraform/app-edge output alb_dns_name`. The same `cd.yml` run that recreates `app-edge` also rewrites the frontend's `config.json` on S3 with the new ALB DNS (see [ADR 0004](../architecture/decisions/0004-frontend-hosting.md)) — the SPA (already up, in `app-base`) picks up the new URL on its next page load, with no frontend redeploy needed.

## Why `app-base` survives a teardown

Two independent guarantees, not one:

1. **Separate state.** `app-edge destroy` only ever touches resources tracked in the `app-edge/terraform.tfstate` key. `app-base`'s resources (including every table) live in a completely separate state (`app-base/terraform.tfstate`) that this command never reads or writes.
2. **The deployer cannot delete a table even if asked to.** `soa-deployer`'s IAM policy (`terraform/iam.tf`) grants scoped `CreateTable`/`UpdateTable`/`DescribeTable` on `soa-*` tables but carries an explicit `Deny` on `dynamodb:DeleteTable` and `dynamodb:DeleteBackup` on that same scope. This means even a mistaken `app-base` apply — one that would otherwise destroy-and-recreate a table (a changed `hash_key`, or a deleted `data` module block) — fails closed with `AccessDenied` instead of silently dropping the table. See [ADR 0003](../architecture/decisions/0003-base-edge-split.md) for the full reasoning.

Deleting a table entirely (true end-of-project teardown) is a **deliberate, human** `terraform apply`/`destroy` against `terraform/app-base/` with admin credentials — not something the pipeline can do, and not part of this routine cycle.

## Related docs

- [ADR 0003 — Base/Edge Split](../architecture/decisions/0003-base-edge-split.md) — the decision and reasoning behind this split.
- [ADR 0002 — Terraform Configuration Topology](../architecture/decisions/0002-terraform-configuration-topology.md) — the original identity/app lifecycle split this refines.
- [ADR 0004 — Frontend Hosting](../architecture/decisions/0004-frontend-hosting.md) — why the frontend lives in `app-base` and survives every edge teardown.
- [compute-layer.md](compute-layer.md) — what the cluster/ALB/modules do, now split across the two configs.
- [adding-a-service.md](adding-a-service.md) — how a new service's two Terraform blocks land in `app-base` and `app-edge`.
- [adding-a-frontend-feature.md](adding-a-frontend-feature.md) — how the frontend picks up a new API URL after a teardown/spin-up cycle.
- [cicd-pipeline.md](cicd-pipeline.md) — how CD applies `app-base` then `app-edge`, and refreshes the frontend's `config.json`.
- [terraform-foundation.md](terraform-foundation.md) — the human-applied identity foundation this all depends on.
- [PRD platform/0006](../action_plan/platform/0006-base-edge-split.md) — the plan and (once filled in) outcome for this split.
- [PRD frontend/0001](../action_plan/frontend/0001-spa-scaffold-and-hosting.md) — the plan and outcome for the frontend's hosting.
