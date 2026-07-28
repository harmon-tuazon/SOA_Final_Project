# 0011 — Rubric Quick Wins (CI tests, README, monitoring, diagrams)

> A batch of small, high-value changes surfaced by the rubric audit: run service unit tests in CI, add a root `README.md`, add CloudWatch alarms + a cost budget (free-tier), and add mermaid architecture/sequence diagrams. Each recovers rubric points at low effort/cost (~$0). Directed by the user after the audit.

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-28
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-28 (user — directed execution of the audited quick-win list)

## 2. User story

As the team, we want to close the low-effort gaps the rubric audit found — untested-in-CI services, no repo entry point, no CloudWatch alarms/budget, and no diagrams — so that the project scores the points that are cheap to earn, without new billable infrastructure.

## 3. Scope

**In scope:**
- **CI runs service tests** — `ci.yml` gains a "Test services" step (`npm ci && npm test` per `services/*` excluding `_template`), so the existing behavioral Jest suites gate PRs. Job name unchanged (branch-protection check).
- **Root `README.md`** — a project front door: what-it-is, architecture summary (with the system diagram), services, quickstart (docker-compose local + push-to-`main` deploy + teardown), and a documentation map into `docs/`.
- **CloudWatch alarms + cost budget** (all free-tier): an ops-alerts SNS topic (reusing `notification_email`, fail-soft), a monthly `aws_budgets_budget` (~$30, 80%/100% + forecast), and metric alarms (Lambda errors, per-service ECS CPU, ALB 5xx) → the alerts topic. Base-resident pieces in `app-base`; edge alarms in `app-edge` (alerts ARN via `terraform_remote_state`).
- **Mermaid diagrams** — system architecture + request-flow/async sequence diagrams in `docs/architecture/overview.md` (system one reused in the README).

**Out of scope (bigger items from the audit, separate work):**
- **Service discovery** (ECS Service Connect / Cloud Map) + an inter-service call — the biggest single gap; its own PRD.
- Multi-stage Dockerfiles; a true cross-service integration / full e2e test.
- Merging `feat/messaging-edge-wiring` (tracked separately; closes the async end-to-end gap).

## 4. Success criteria

1. `ci.yml` runs each service's `npm test`; a failing service test fails the required CI check. All three service suites pass as-is.
2. Root `README.md` exists with architecture, services, quickstart, and a docs map; renders on GitHub (mermaid included).
3. `terraform validate` passes on both configs with the monitoring added; `plan` shows only **additive** resources (budget, topic, subscription(s), alarms) — nothing destroyed/replaced. All free-tier ($0).
4. On merge, CD applies the monitoring (base then edge) with no manual step; the budget + alarms appear in the account.
5. At least two mermaid diagrams (system architecture + a sequence) exist in `docs/`; accurate to what's on `main`.
6. `infra-reviewer` passes on the monitoring change (free, additive, correct base/edge placement, no interface breakage for existing service callers).

## 5. Resources

| Resource | Type | Cost |
| --- | --- | --- |
| Service-test CI step | `.github/workflows/ci.yml` | $0 |
| Root README + diagrams | docs | $0 |
| `soa-alerts` SNS topic + email sub | `aws_sns_topic`/`_subscription` | $0 |
| Cost budget | `aws_budgets_budget` (first 2 free) | $0 |
| Metric alarms (Lambda/ECS/ALB) | `aws_cloudwatch_metric_alarm` (first 10 free) | $0 |

**Total: ~$0** — all free-tier; no compute/data added.

## 6. Scripts / commands

```bash
# Local checks
for s in services/*/; do [ "$s" = services/_template/ ] || (cd "$s" && npm ci && npm test); done
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-edge validate

# Ship: PR -> CI (now incl. service tests) -> merge -> CD applies base then edge (monitoring)
```

No destructive/manual command — the monitoring deploys via CD (additive, free).

## 7. Planned agents

- **`pipeline-engineer`** — add the service-test step to `ci.yml`; verify suites pass.
- **`terraform-engineer`** — alerts topic + budget + alarms (base/edge split, free-tier, optional module inputs).
- **`documentation-keeper`** — root `README.md` + mermaid diagrams.
- **`infra-reviewer`** — audit the monitoring change (free, additive, no interface breakage).
- **Main session** — writes this PRD, bundles the changes into a PR, drives merge/verify.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 CI tests | inspect ci.yml; local `npm test` per service passes; PR CI runs them |
| #2 README | render on GitHub; has the required sections + a diagram |
| #3 terraform | `validate` both; `plan` additive-only, $0 |
| #4 CD | merge CD applies base+edge; `aws budgets`/`cloudwatch describe-alarms` show them |
| #5 diagrams | mermaid blocks present + accurate |
| #6 review | `infra-reviewer` verdict |

## 9. Additional considerations

- **Ops alerts reuse the notifications inbox** (`notification_email`) for simplicity — a demo-grade choice; a dedicated `alerts_email` is a trivial future split.
- **No new billable resource** — alarms/budget are free-tier; this only *improves* cost visibility (the budget guards spend).
- **Rollback:** all changes are files or free resources; the monitoring dies with `app-edge destroy` (edge alarms) / stays in `app-base` (budget, topic, Lambda alarm) at $0.
- **Doesn't close the big gaps** — service discovery and the async producer wiring are tracked separately; this batch is the cheap-points layer only.

---

## Outcome

Executed as planned; shipped in PR #29, with a follow-up deployer-IAM grant (below).

**Delivered & verified:**
- **CI runs service tests** — `ci.yml` now runs each service's `npm test`; **232 tests** (order 64, product 73, user 95) gate PRs. Verified green on #29.
- **Root `README.md`** — project entry point with an embedded mermaid system-architecture diagram; plus two sequence diagrams (sync CRUD, async sign-up) in `docs/architecture/overview.md`.
- **Monitoring** — deployed and confirmed live: `soa-alerts` SNS topic (2 email subs, pending confirmation), the `soa-monthly-cost` **$30** budget, and **5 CloudWatch alarms** (`soa-notification-worker-errors`, `soa-alb-5xx`, `soa-order/product/user-cpu-high`). All free-tier.
- Reviewed by infra-reviewer (additive, free, base/edge-correct, no interface breakage).

**Deviation — deployer lacked AWS Budgets permission:** the merge CD's `app-base` apply failed with `AccessDeniedException: budgets:ModifyBudget` — `soa-deployer` had never needed AWS Budgets (a service not previously used) and its policy didn't grant it. Added `budgets:*` to the consolidated `GlobalServiceManagement` statement in `terraform/iam.tf` (human-applied to the root, since the deployer can't modify its own IAM; policy still fits under the 6144-char limit), then re-ran the failed CD → the budget and all edge alarms created cleanly. This is the same "new-resource-type ⇒ human deployer grant" pattern as the earlier `lambda:*` grant.

**Note:** the SPA/service work landed around the same time (`feat/messaging-edge-wiring` merged, closing the async end-to-end gap) — unrelated to this batch but part of the same session's progress.

**Not closed by this batch (separate work):** service discovery (ECS Service Connect / Cloud Map), multi-stage Dockerfiles, cross-service integration/e2e tests.
