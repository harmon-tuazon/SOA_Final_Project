# 0005 — Service Factory (template + contract + /new-service)

> Turn the proven `items` service into a reusable factory: extract `services/_template/`, codify the binding `service-contract` rule, and build the `/new-service` command that interviews a developer, generates a per-service PRD, and (on approval) scaffolds a fully-wired service (app + Terraform). Remove `items` and generalize the pipeline to build any service. No new AWS infrastructure (~$0).

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-14
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-14 (user)

> Decisions settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the platform owner, I want a self-service factory — a template, a written contract, and a `/new-service` command — so that a teammate who knows only React + Express can create a fully-wired, deployable microservice by describing it, while I keep an approval gate and the guardrails catch mistakes. This makes the golden path *repeatable and AI-executable*, not a manual copy each time.

## 3. Scope

**In scope:**
- **`services/_template/`** — a genericized copy of `items`: the standard Dockerfile, `package.json`, `src/app.js` (`/health` + env-config reading + one **placeholder** CRUD route), `src/index.js`, tests, `.dockerignore`/`.gitignore`, and a README. Service-specific bits become documented placeholders (e.g. `__SERVICE_NAME__`, `__ROUTE__`, `__TABLE_ENV__`) that `/new-service` replaces. Never deployed.
- **`.claude/rules/service-contract.md`** — the binding conventions for every service (config from env only; `/health` fast + DB-free; the standard Dockerfile; one DynamoDB table per service; the `data` + `ecs-service` Terraform block pattern; task role carrying the `soa-boundary`, scoped to its own table; tests). A rule like `documentation.md` / `action-plan.md`.
- **`.claude/commands/new-service.md`** — the `/new-service` command procedure: (1) **app-level interview** (name, one-line purpose, entities/fields → table hash key, routes, async needs); (2) generate `docs/action_plan/<service>/0001-service-scaffold.md` from the answers (app spec + auto-derived infra); (3) **wait for user approval**; (4) scaffold — copy `_template` → `services/<name>/`, replace placeholders, add the `data` + `ecs-service` blocks + env to `terraform/app/main.tf`, add outputs; (5) run `fmt`/`validate` + `npm test`; (6) open a PR. Delegates to `app-engineer` (app) + `terraform-engineer` (Terraform), backstopped by `infra-reviewer`/CI. Follows `service-contract.md`.
- **Remove `items`** — delete `services/items/`, its `items_table` + `items_service` module blocks and outputs in `terraform/app/`; repoint `adding-a-service.md` / `compute-layer.md` from `items` to `_template`.
- **Generalize the pipeline** — `ci.yml` (docker build) and `cd.yml` (build + push) iterate over **every** `services/*` directory **except `_template`**, so the pipeline is no longer hardcoded to `items` and cleanly handles 0..N services (with 0 services it builds nothing and just applies Terraform).
- **CLAUDE.md** — a short pointer to `service-contract.md` and the `/new-service` workflow.

**Out of scope (later):**
- An **async worker template** (SQS + Lambda) — a separate factory piece once the async pattern is built once.
- Actual domain services (Order/Product/User) — created *via* `/new-service` afterward.
- Frontend (S3) hosting, Cognito, HTTPS.

## 4. Success criteria

1. `services/_template/` exists, contains **no `items`-specific** content (only placeholders/generic), and `docker build services/_template` succeeds.
2. `.claude/rules/service-contract.md` and `.claude/commands/new-service.md` exist and are internally consistent with the actual modules/contract.
3. **`items` fully removed:** no `services/items/`, no `items_*` in `terraform/app/`, no `items_*` outputs, no `items` reference in the workflows; `terraform -chdir=terraform/app validate` passes.
4. **Pipeline generalized:** `ci.yml`/`cd.yml` iterate `services/*` (skipping `_template`); with zero services present, CI builds nothing and CD applies Terraform without error.
5. CI is green on the PR; the merge's CD applies `terraform/app` cleanly (network + cluster + ALB, no service).
6. `infra-reviewer` passes on the Terraform removal + pipeline generalization (still keyless, role-separated, no billable surprises).
7. After verification, `terraform destroy terraform/app` returns to ~$0.
8. **(Manual)** a `/new-service` dry-run on a throwaway name produces a correct service PRD (interview → PRD), confirming the command works before it's relied on.

## 5. Resources

| Resource | Type | Cost |
| --- | --- | --- |
| `services/_template/` | files | $0 |
| `.claude/rules/service-contract.md`, `.claude/commands/new-service.md` | framework files | $0 |
| Pipeline generalization | `.github/workflows/*` | $0 |
| Terraform `items` removal | `terraform/app` edit | $0 |

**Total: ~$0.** No new AWS resources are designed. (The merge-triggered CD apply briefly recreates the free network + cluster and the billable ALB with no service; destroyed immediately after — net ~$0.)

## 6. Scripts / commands

```bash
# Local checks
docker build services/_template          # template builds
terraform -chdir=terraform/app validate  # items removed cleanly

# Ship it (PR -> CI -> merge -> CD)
git checkout -b service-factory
git add -A
git commit -m "Add service factory: _template, service-contract rule, /new-service; remove items"
git push -u origin service-factory
# PR -> CI (builds services/* [none], plan) -> merge -> CD applies terraform/app

# After merge: not demoing a service, so tear the shared infra back down
terraform -chdir=terraform/app destroy   # -> ~$0

# Verify the factory works (dry run, no deploy):
#   /new-service ping   -> should interview + produce a service PRD
```

## 7. Planned agents

- **`app-engineer`** — extract `services/_template/` from `services/items/` (genericize with placeholders), adjust tests; confirm `docker build` + `npm test`.
- **`terraform-engineer`** — remove the `items` `data`/`ecs-service` blocks + outputs from `terraform/app/`; `fmt`/`validate`.
- **`pipeline-engineer`** — generalize `ci.yml`/`cd.yml` to loop over `services/*` (excluding `_template`) for build/push; keep keyless OIDC + role separation.
- **Main session** — writes `.claude/rules/service-contract.md` and `.claude/commands/new-service.md` (rules/commands are framework, main-session-owned); orchestrates; drives the PR + the post-merge `destroy`.
- **`infra-reviewer`** — audits the Terraform removal + pipeline generalization (no billable surprises, still keyless, `_template` correctly skipped).
- **`documentation-keeper`** — updates `adding-a-service.md` / `compute-layer.md` (items → `_template`) and documents the `/new-service` workflow.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 template builds | `docker build services/_template`; grep for stray `items` |
| #2 rule + command | review for consistency with the real modules/contract |
| #3 items gone | `git status` / grep; `terraform -chdir=terraform/app validate` |
| #4 pipeline generic | inspect the loop; CI run builds `services/*` (none) without error |
| #5 CI/CD | PR CI green; merge CD applies `terraform/app` |
| #6 review | `infra-reviewer` verdict |
| #7 $0 | `terraform destroy` + `aws elbv2 describe-load-balancers` empty |
| #8 command works | run `/new-service ping` → produces a valid service PRD |

## 9. Additional considerations

- **Merge-then-destroy wrinkle (accepted):** the change touches `terraform/app` + `cd.yml` + `services/`, so the merge triggers CD, which recreates the shared infra (free network + cluster + the **billable ALB**, no service). We destroy right after since nothing is being demoed. Making the cluster/ALB conditional on services existing is deferred as more complexity than it's worth now.
- **Safety of AI-generated infra:** `/new-service` **parameterizes validated templates** (it does not improvise infra), and every run is gated by (a) your PRD approval, (b) `infra-reviewer`, (c) CI, and (d) the least-privilege deployer + `soa-boundary`. Two layers: rules guide the AI onto the paved road; guardrails stop it leaving.
- **AI-executable for teammates:** `.claude/` is committed, so any teammate who clones the repo and uses Claude Code inherits `service-contract.md` + `/new-service` automatically — no per-person setup. A non-infra teammate describes a service; their Claude builds it on the paved road; you approve the PRD + PR.
- **Rollback/teardown:** all changes are files or reversible Terraform; `terraform/app` stays destroyed at ~$0 between sessions.
- **Follow-ups:** async worker template (SQS/Lambda); route `/health` externally if wanted; add per-service `npm test` to CI; the first real service (Order/Product/User) exercises `/new-service` for real.

---

## Outcome

Executed as planned; the factory is built and the pipeline proven generic. Shipped in PR #8 (`Add service factory: _template, service-contract, /new-service; remove items; generalize pipeline`), merged to `main`.

**Delivered:**
- `services/_template/` — genericized from `items` with placeholder tokens (`__SERVICE_NAME__`, `__RESOURCE__`, `__TABLE_ENV__`); `npm test` (health) passes.
- `.claude/rules/service-contract.md` — the binding app + infra contract and naming conventions.
- `.claude/commands/new-service.md` — the `/new-service` procedure (app interview → per-service PRD → **approval gate** → scaffold app + Terraform → PR). Registered as a skill.
- `items` fully removed: `services/items/` deleted, `items_*` module blocks/outputs stripped from `terraform/app/`, no `items` reference in the workflows.
- Pipeline generalized: `ci.yml`/`cd.yml` discover `services/*` (excluding `_template`) and derive `soa-<name>` names — 0..N services, 0-service safe.
- `CLAUDE.md` golden-path pointer; `compute-layer.md`/`adding-a-service.md`/`overview.md` repointed items → `_template`.

**Verification:**
- CI green on PR #8; merge CD ran 3m49s — "Discover services" found none, build loop no-op'd, full `terraform apply` created network + cluster + ALB (no service). Confirms the generalized pipeline handles the empty case (criteria #4, #5).
- `terraform -chdir=terraform/app validate` passes with `items` gone (criterion #3).
- Post-merge `terraform -chdir=terraform/app destroy` → **15 destroyed, ~$0** (criterion #7).

**Deviations / notes:**
- The `/new-service` example Terraform block was missing `name_prefix` (a required input on both the `data` and `ecs-service` modules); fixed in the command file before closeout so a generated service passes `validate`.
- `infra-reviewer` (criterion #6) stalled on a watchdog timeout with no verdict; the critical items (keyless OIDC preserved, role separation, `_template` correctly excluded, no billable surprises beyond the transient ALB) were verified manually by reading the workflow + module diffs.
- Criterion #8 (a `/new-service` dry-run) is deferred to the first real service — the command is reviewed for consistency against the live modules and is ready to run. Building the first domain service (Order/Product/User) via `/new-service` will exercise it end-to-end.

**Follow-ups (unchanged from §9):** async worker template (SQS/Lambda), S3 frontend + Cognito + HTTPS, and per-service `npm test` in CI.
