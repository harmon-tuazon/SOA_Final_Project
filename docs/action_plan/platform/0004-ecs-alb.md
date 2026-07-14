# 0004 — ECS + ALB (Compute Layer + Golden-Path Modules)

> Stand up the compute layer — an ECS Fargate cluster, a single shared ALB (HTTP), security groups, ECR — plus the reusable `data` and `ecs-service` Terraform modules, and one minimal reference service (`items`) that proves the whole path. Expands CD to build/push container images and deploy to ECS. This is the first billable infrastructure (~$25/mo while running).

## 1. Status & metadata

- **Status:** Approved
- **Date:** 2026-07-14
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-14 (user)

> Decisions settled via `/grill-me`. Execution starts only after this PRD is marked **Approved**.

## 2. User story

As the platform owner, I want a reusable "paved road" — Terraform modules that turn a container + a table into a running, load-balanced service — proven by one reference service, so that future services (built by teammates who don't know infrastructure) are a copy-paste of module blocks and the pipeline deploys them automatically.

## 3. Scope

**In scope (all in `terraform/app/`, the pipeline-applied config):**
- **`modules/ecs-cluster/`** (shared, created once): the ECS Fargate cluster, the internet-facing **ALB** (in the 2 public subnets), the **ALB security group** (inbound `:80` from the internet), an HTTP `:80` **listener** (default action: fixed 404), a CloudWatch log group namespace, and the shared **ECS task execution role**.
- **`modules/data/`** (reusable): a DynamoDB table (on-demand billing), inputs `name`/`hash_key` (+ optional range key), outputs `name`/`arn`.
- **`modules/ecs-service/`** (reusable — the core of the paved road): per-service **ECR repo**, **CloudWatch log group**, **task role** (carrying the **`soa-boundary`**, scoped to the service's own table), **target group** (`target_type = ip`, health check `/health`), **listener rule** (`path → target group`), **task security group** (app port reachable **only from the ALB SG**), **task definition** (Fargate, `awsvpc`, cpu/memory, exec role + task role, container with image/port/env/logs), **ECS service** (public subnets + task SG + `assign_public_ip`), and **Service Auto Scaling** (CPU target, min 1 / max 2).
- **One reference service `items`:** `services/items/` (Express: `GET /health`, `GET /items`, `POST /items` backed by DynamoDB via the AWS SDK), its `Dockerfile`, tests, and its wiring in `terraform/app/` (a `data` + `ecs-service` block, route `/items*`).
- **`docker-compose.yml`** (repo root) for local dev (the `items` service + DynamoDB Local).
- **Pipeline:** CI builds the image (catch Dockerfile errors) + `plan`; **CD builds + pushes the image tagged `$GITHUB_SHA` to ECR, then `terraform apply` deploys it** to ECS (image tag passed as a Terraform variable).

**Out of scope (later):**
- The `/new-service` command + `services/_template/` extraction (follow-up PRD — needs this reference first).
- HTTPS / ACM / a domain (HTTP-only for now).
- Cognito auth, S3/CloudFront frontend hosting, SQS/SNS/Lambda async — separate PRDs.
- Additional real services (products/orders) — built on the template later.

## 4. Success criteria

1. `terraform validate` passes; `plan` shows the cluster, ALB, SGs, ECR, table, task def, service, target group, listener rule, and autoscaling to add — 0 destroys.
2. CI builds the `items` image and plans `terraform/app/` green on the PR.
3. CD builds + pushes the image to ECR and `terraform apply` succeeds; the ECS service reaches a **steady state** with a healthy task (ALB health check passing).
4. `curl http://<alb-dns>/health` returns **200**; `POST`/`GET /items` writes+reads a real DynamoDB item end-to-end.
5. The `items` **task role carries the `soa-boundary`** and is scoped to only the `items` table; the **task SG** allows the app port **only from the ALB SG** (`infra-reviewer` confirms).
6. The `ecs-service` + `data` modules are genuinely reusable — a second service would be one `data` + one `ecs-service` block.
7. Cost while running ≈ ALB + 1 task; `terraform destroy` on `terraform/app/` returns it to ~$0 (`infra-reviewer` confirms no hidden always-on beyond ALB + task).

## 5. Resources

| Resource | Terraform type | Cost |
| --- | --- | --- |
| ECS cluster | `aws_ecs_cluster` | Free |
| **ALB** + listener | `aws_lb`, `aws_lb_listener` | **~$16/mo while up** |
| Target group | `aws_lb_target_group` | Free |
| Security groups ×2 | `aws_security_group` | Free |
| **Fargate task** (0.25 vCPU/0.5 GB, ×1) | `aws_ecs_task_definition`, `aws_ecs_service` | **~$9/mo while running** |
| Autoscaling | `aws_appautoscaling_target/policy` | Free |
| ECR repo | `aws_ecr_repository` | ~$0 (free-tier) |
| DynamoDB table | `aws_dynamodb_table` (PAY_PER_REQUEST) | ~$0 (free-tier) |
| Log groups | `aws_cloudwatch_log_group` | ~$0 (free-tier) |
| Task/exec roles | `aws_iam_role` | Free |

**Total: ~$25/mo while running, ~$0 when `terraform destroy`ed.** First billable infrastructure in the project.

## 6. Scripts / commands

```bash
# Local dev (developer loop)
docker-compose up                              # items + DynamoDB Local
terraform -chdir=terraform/app plan            # preview (read-only)

# Ship it (PR -> CI -> merge -> CD)
git checkout -b add-ecs-items
git add terraform/app services/items docker-compose.yml .github/workflows/
git commit -m "Add ECS cluster + ALB + modules + items reference service"
git push -u origin add-ecs-items
# open PR -> CI builds image + plans -> review -> merge
#   merge -> CD builds+pushes image, terraform apply  (⚠️ creates ALB + Fargate task = first billable)

# Verify
curl http://<alb-dns-name>/health              # -> 200
curl -X POST http://<alb-dns-name>/items -d '{"id":"1","name":"test"}' -H 'content-type: application/json'
curl http://<alb-dns-name>/items               # -> the item

# Teardown (return to ~$0 between sessions)
terraform -chdir=terraform/app destroy
```

## 7. Planned agents

- **`terraform-engineer`** — writes `modules/ecs-cluster/`, `modules/data/`, `modules/ecs-service/`, and the `items` wiring in `terraform/app/`. Validates (plan-only).
- **`app-engineer`** — writes `services/items/` (Express app + Dockerfile + tests) and `docker-compose.yml`; runs lint/tests locally.
- **`pipeline-engineer`** — expands `ci.yml` (docker build for `items`) and `cd.yml` (build + push image tagged `$GITHUB_SHA` to ECR, then `terraform apply` with the image tag var; handles first-run ECR ordering).
- **`infra-reviewer`** — audits the modules (SG tightness, task-role boundary + table scope, `target_type = ip`, no direct task exposure, cost) and the workflow changes; pre-checks deployer permission coverage for the new resource types.
- **Main session** — orchestrates; drives the PR/merge; runs the verification curls; runs `destroy` for teardown.
- **`documentation-keeper`** — writes the "how the compute layer + modules work / how to add a service" docs and updates the architecture overview.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 plan clean | `terraform -chdir=terraform/app plan` (engineer + CI) |
| #2 CI | PR run: image builds, `plan` green as `soa-ci-plan` |
| #3 CD steady state | merge → CD applies; `aws ecs describe-services` shows `runningCount = desired`, no failed deployments |
| #4 works E2E | `curl` `/health` → 200; `POST`/`GET /items` round-trips through DynamoDB |
| #5 least-privilege | `infra-reviewer` + `aws iam get-role` — task role has the boundary + table-scoped policy; task SG source is the ALB SG only |
| #6 reusable | review: a 2nd service = one `data` + one `ecs-service` block |
| #7 cost | `infra-reviewer`: only ALB + task are billable; `destroy` plan removes everything |

## 9. Additional considerations

- **💵 First billable infra.** ALB (~$16/mo) + 1 Fargate task (~$9/mo) ≈ ~$25/mo *while up*. `terraform destroy terraform/app` returns to ~$0. Adopt destroy-between-sessions now that real money is involved.
- **Task role MUST carry the `soa-boundary`.** The deployer's `iam:CreateRole` is conditioned on the boundary (PRD 0001), so the `ecs-service` module must set `permissions_boundary` on every task role it creates — otherwise CD's apply fails with AccessDenied. (Verify before merge.)
- **Public subnets + public IP, but not exposed.** Tasks get a public IP (to pull from ECR with no NAT), but the **task SG only allows the app port from the ALB SG** — so nothing reaches a task except through the ALB.
- **Two roles:** execution role (ECS pulls image + writes logs) vs task role (the app's runtime permissions, boundary-scoped). The module wires both.
- **First-run ECR ordering** (pipeline detail): the ECR repo must exist before the first image push, and the ECS service needs a pushed image to become healthy. The `pipeline-engineer` + `terraform-engineer` sequence this (e.g. apply infra incl. ECR → build+push → apply/roll the service to the new tag). Documented in the pipeline, not a user decision.
- **Deployer permission risk:** creating ECS/ALB/ECR/task-roles may surface a missing action → CD fails; fix via a human `terraform apply` of the deployer policy (same pattern as prior PRDs). `infra-reviewer` pre-checks to minimize this.
- **HTTP only** — unencrypted; fine for a demo, not real users. HTTPS/ACM is a follow-up once a domain exists.
- **This produces the reference service that becomes `services/_template/`** in the follow-up `/new-service` PRD.

---

## Outcome

_Filled after execution._
