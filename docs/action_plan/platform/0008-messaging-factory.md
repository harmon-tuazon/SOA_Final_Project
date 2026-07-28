# 0008 — Async Messaging Factory (SQS → Lambda → SNS notifications)

> Build the reusable async branch the architecture has always described but never had — a `messaging` module (SQS + DLQ + SNS + email subscription) and a `lambda` worker module — deploy one concrete **notification** pipeline on it, and wire the **user service** as its first producer so a new user's first sign-in sends a welcome email.

## 1. Status & metadata

- **Status:** Done <!-- Draft → Approved → In Progress → Done (or Abandoned) -->
- **Date:** 2026-07-24
- **Approved:** 2026-07-24 by the repo owner ("start executing them all in the correct order")
- **Completed:** 2026-07-28 (PRs #25/#27/#28; SQS→Lambda→SNS path deployed)
- **Author:** Jean-Luc (with Claude Code)

> Execution may only start once the user has confirmed **Approved**. The design below was settled via `/grill-me` on 2026-07-24.

**Amendment (2026-07-24, at the repo owner's direction):** all work in this PRD — Terraform modules/wiring, the `iam.tf` grant text, and the workflow changes in §5.1 — is executed **in this repo** by the planned agents, superseding the DevOps-handoff pattern described in the ownership note below. The **admin apply of the root-identity change (§9.1) remains a human action**, tracked as [`docs/to-dos/admin-apply-lambda-grant.md`](../../to-dos/admin-apply-lambda-grant.md); the SNS subscription confirmation and `NOTIFICATION_EMAIL` variable are tracked in [`docs/to-dos/`](../../to-dos/README.md) as well.

**This is the `platform/0008` reserved by [`order/0001`](../order/0001-service-scaffold.md) and [`user/0001`](../user/0001-user-service.md).** It is the largest of the three PRDs being run together and has the only change that touches the **root identity foundation** — see §9.1.

**Depends on [`user/0001`](../user/0001-user-service.md)** (the producer seam lives in the user service's lazy profile upsert) and therefore transitively on [`platform/0009`](../platform/0009-cognito-user-pool.md). **Run order: `platform/0009` → `user/0001` → (admin applies the deployer IAM change, §9.1) → `platform/0008`.**

**Ownership note:** consistent with the amendment in [`order/0001` §3](../order/0001-service-scaffold.md), **all infrastructure — Terraform, the root-identity IAM change, and the CI/CD workflow edits — is owned by the DevOps team** and specified here (§5.1) as a handoff, not written by this PRD. **Application code is authored in this repo:** the `functions/notification-worker/` Lambda handler + tests, and the user-service producer change. If the ownership split has moved, only §3/§6/§7 shift — the specs in §5.1 are the same either way.

## 2. User story

As the **project team**, we want **the event-driven half of the architecture actually built** — a message queue, a Lambda worker, and SNS fan-out — so that **the rubric's asynchronous-communication and Lambda/SQS requirements are met with a working, testable path**, not just a diagram.

As a **new user**, I want **a welcome email the first time I sign in**, so that **the application feels like it acknowledges my account** — and so the team has a visible, browser-triggered demonstration of the async path that needs no console or CLI.

## 3. Scope

**In scope:**

- A reusable **`terraform/modules/messaging/`** — an `aws_sqs_queue` (Standard) + its dead-letter `aws_sqs_queue` (redrive) + an `aws_sns_topic` + an `aws_sns_topic_subscription` (email, address from a variable).
- A reusable **`terraform/modules/lambda/`** — an `aws_lambda_function` (Node 20, zip), its `soa-*-exec` execution role (carrying `soa-boundary`, scoped to *its* queue + topic + logs), and an `aws_lambda_event_source_mapping` from a queue.
- One concrete pipeline wired in **`app-base`**: `module "notifications"` (messaging) + `module "notification_worker"` (lambda), consuming the notifications queue and publishing to the notifications topic. **All of it is free-tier and lives in `app-base`** — the async branch has no idle cost and no reason to churn with the billable edge ([ADR 0001](../../architecture/decisions/0001-platform-and-compute-architecture.md), [ADR 0003](../../architecture/decisions/0003-base-edge-split.md)).
- **`functions/notification-worker/`** — the Node handler (SQS event → format → `sns:Publish`), `package.json`, and unit tests. Establishes the `functions/` convention CI/CD already anticipates ([`ci.yml:34-39`](../../../.github/workflows/ci.yml#L34-L39)).
- A small extension to the shared **`ecs-service`** module: an optional `sqs_send_arns` input that scopes a producer's task role to `sqs:SendMessage` on named queues, and lets a queue URL be injected as env.
- **The user service as the first producer:** on the lazy profile upsert (first `GET /users/me`), it publishes a `UserProfileCreated` event to the notifications queue. Its task role gains `sqs:SendMessage` scoped to that one queue.
- **The root-identity IAM change** (§9.1): grant `soa-deployer` the `lambda:*` it entirely lacks today. Human/admin-applied on `terraform/` root.
- **CI/CD:** CI packages + tests `functions/*`; CD zips each function (SHA-tracked), applies, and pushes code via `aws lambda update-function-code`; plus a **smoke-test step** that publishes a synthetic event and asserts the Lambda logged an invocation.
- Docs: a `docs/operations/async-messaging.md` runbook, plus index/README updates.

**Out of scope:**

- **A standalone Notification *ECS* service.** The notification worker is a Lambda, per the architecture ([CLAUDE.md](../../../CLAUDE.md)); there is no container here. The rubric's "Notification Service" is satisfied by this Lambda pipeline.
- **SMS.** Email only. SMS costs real money per message, starts in a sandbox, and needs a registered origination number — no value for a graded demo. A later PRD if ever.
- **SES.** Rejected during `/grill-me`: SES has its own sandbox/identity-verification friction and drops the SNS fan-out the architecture calls for. SNS email is the path.
- **Order service as a producer.** `order/0001` referenced an order-confirmation email; that is a follow-up `order/0002` reusing this exact factory. Only the user service is wired here.
- **FIFO / exactly-once / ordering.** Standard queue; notifications tolerate a rare duplicate and need no ordering.
- **A Cognito Post-Confirmation trigger.** Rejected during `/grill-me` — it's a Cognito→Lambda coupling that skips the inter-service queue. The producer seam is the user service's upsert.
- **Fan-out to multiple subscribers, subscription self-service, an unsubscribe UI.** One email subscription (a tfvar address) for the demo; managing many recipients is future work.
- **Any hand-run `terraform apply` / `aws` / `docker` / `zip`-deploy.** CI/CD owns deployment; the one exception is the admin root-identity apply in §9.1, which is a named, deliberate human action.

### 3.1 The event

`UserProfileCreated`, published by the user service to the notifications SQS queue as JSON:

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | `"UserProfileCreated"` — lets the worker branch as more event types arrive |
| `userId` | string | the Cognito `sub` |
| `email` | string | from the verified token claim — the welcome email's recipient context |
| `displayName` | string? | if the profile carried one |
| `occurredAt` | string | ISO-8601, set by the producer |

The worker formats a welcome message and calls `sns:Publish` on the notifications topic; SNS delivers to the confirmed email subscription.

### 3.2 The path

```
user service (app-edge, ECS)                         [rubric: microservice → queue]
   │  first GET /users/me → lazy upsert → sqs:SendMessage
   ▼
notifications SQS queue (app-base)  ──(on repeated failure)──►  notifications-dlq
   │  event source mapping (batch)
   ▼
notification-worker Lambda (app-base, Node 20)       [rubric: SQS-triggered Lambda]
   │  sns:Publish
   ▼
notifications SNS topic (app-base)  ──►  📧 confirmed email subscription
```

## 4. Success criteria

Each is checkable by a command in §8.

1. `npm test` in `functions/notification-worker/` passes: given a synthetic SQS event, the handler calls `sns:Publish` (mocked) with a non-empty subject/message derived from the record, and a malformed record is skipped without throwing (so one bad message can't fail a whole batch).
2. `npm test` in `services/user/` still passes **and** gains a case proving the upsert path calls `sqs:SendMessage` (mocked) exactly once on **first** creation and **not** on a subsequent `GET /users/me`.
3. `terraform -chdir=terraform/app-base fmt -check`, `validate`, and `plan` pass; the plan shows the queue, DLQ, topic, subscription, Lambda, exec role, and event-source-mapping as **creates — 0 destroys, 0 replacements** of any existing resource.
4. `terraform -chdir=terraform/app-edge validate` passes and its `plan` shows the user service's task-role policy gaining `sqs:SendMessage` scoped to the notifications queue ARN **only** (no `*`), and `NOTIFICATIONS_QUEUE_URL` injected as env — **0 destroys**.
5. The Lambda execution role in the plan carries **`soa-boundary`**, and its policy is scoped to the notifications queue (`sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`), the notifications topic (`sns:Publish`), and its own log group — nothing account-wide, no inline policy, no AWS-managed policy.
6. **The deployer IAM change is present and minimal:** `git diff terraform/iam.tf` adds a `lambda` grant and nothing else; after the admin apply (§9.1), `soa-deployer` can `lambda:CreateFunction`. Before it, CD fails closed with `AccessDenied` on Lambda (proving the boundary/grant is doing its job) rather than silently over-permissioning.
7. `grep -rInE "elb\.amazonaws\.com" functions services/user` returns nothing (CI endpoint gate).
8. After merge + CD: the CloudWatch Logs group `/aws/lambda/${name_prefix}-notification-worker` shows an invocation from the smoke-test publish, with no error.
9. After the email subscription is confirmed (§9.2) and a real user signs in for the first time in the SPA, a welcome email arrives at the subscribed address.
10. A message that fails processing 3× lands in `notifications-dlq` (verifiable by the redrive config in the plan; exercised only if a poison message occurs).
11. `docs/action_plan/README.md` shows `platform/0008` as no longer reserved, and `docs/operations/async-messaging.md` exists and is linked from `docs/README.md`.

## 5. Resources

**AWS resources created:**

| Resource | Terraform type | Config | Cost |
| --- | --- | --- | --- |
| `soa-notifications` queue | `aws_sqs_queue` | `app-base` | **Free tier** — 1M requests/mo free. Permanent |
| `soa-notifications-dlq` | `aws_sqs_queue` | `app-base` | **Free tier** |
| `soa-notifications` topic | `aws_sns_topic` | `app-base` | **Free tier** — 1M publishes/mo; first 1,000 email deliveries/mo free, then ~$2/100k |
| email subscription | `aws_sns_topic_subscription` | `app-base` | **Free** (a config object) |
| `soa-notification-worker` Lambda | `aws_lambda_function` | `app-base` | **Free tier** — 1M invocations + 400k GB-s/mo free; a demo is ~$0. Scales to zero |
| Lambda exec role + `soa-*` policy | `aws_iam_role`, `aws_iam_policy` | `app-base` | **Free** |
| event source mapping | `aws_lambda_event_source_mapping` | `app-base` | **Free** |
| `/aws/lambda/soa-notification-worker` logs | `aws_cloudwatch_log_group` | `app-base` | **Free tier** — 5 GB/mo |
| user task-role `sqs:SendMessage` scope | (edit to `ecs-service` policy) | `app-edge` | **Free** |

**Net new cost: ~$0.** Every resource is free-tier, event-driven, and scales to zero. Nothing here is destroyed by the routine `app-edge` teardown — the async branch lives in `app-base` and stays up at no cost.

**Repo files touched:**

- **New (app code, in scope here):** `functions/notification-worker/{index.js,package.json,tests/handler.test.js}`, plus a committed bootstrap `functions/notification-worker/bootstrap.zip`-equivalent placeholder (or an empty-handler zip Terraform references on first apply — see §5.1 note).
- **New (infra, DevOps handoff):** `terraform/modules/messaging/{main.tf,variables.tf,outputs.tf}`, `terraform/modules/lambda/{main.tf,variables.tf,outputs.tf}`.
- **New (docs):** `docs/operations/async-messaging.md`.
- **Edited (app code, in scope):** `services/user/src/*` (publish on upsert; read `NOTIFICATIONS_QUEUE_URL`), `services/user/tests/*` (the §4.2 case).
- **Edited (infra, DevOps handoff):** `terraform/iam.tf` (deployer `lambda:*`), `terraform/app-base/main.tf` (+2 module blocks + a `notification_email` var), `terraform/app-base/outputs.tf` (+queue url/arn, topic arn), `terraform/app-base/variables.tf` (+`notification_email`), `terraform/app-edge/main.tf` (+`local.notifications_queue_*` from remote state; pass to `user_service`), `terraform/modules/ecs-service/{variables.tf,main.tf}` (+`sqs_send_arns`), `.github/workflows/ci.yml` + `cd.yml` (functions packaging + smoke test).
- **Not touched:** `services/_template/`, `services/order/`, `terraform/bootstrap/`, `terraform/modules/{data,alb,network,ecs-cluster,frontend,cognito}/`.

**New dependency:** `@aws-sdk/client-sns` (Lambda) and `@aws-sdk/client-sqs` (user service producer).

**Derived names** (per [service contract](../../../.claude/rules/service-contract.md) conventions):

| | |
| --- | --- |
| Queue / DLQ | `soa-notifications` / `soa-notifications-dlq` |
| Topic | `soa-notifications` |
| Lambda | `soa-notification-worker` |
| Function folder | `functions/notification-worker/` |
| Producer env | `NOTIFICATIONS_QUEUE_URL` (injected into the user container) |

### 5.1 DevOps handoff — the infrastructure changes

Specs only; not written by this PRD. Ordered by when they must land.

**a) Root identity — `terraform/iam.tf` (ADMIN-APPLIED, must land before CD runs 0008):**

Add one statement to the deployer permissions document, mirroring the existing `sqs:*`/`sns:*` management grants ([iam.tf:437-450](../../../terraform/iam.tf#L437-L450)). `iam:PassRole` on `soa-*` roles is already present ([iam.tf:554](../../../terraform/iam.tf#L554)), so passing the Lambda exec role needs nothing new; the `soa-boundary` already permits the worker's `sqs:Receive*`/`sns:Publish` ([iam.tf:115-131](../../../terraform/iam.tf#L115-L131)).

```hcl
  # Lambda: the async notification worker (PRD platform/0008). Mirrors the
  # broad sqs:*/sns:* management grants above; infra-reviewer may tighten to
  # the create/update/invoke/event-source-mapping subset if desired.
  statement {
    sid       = "LambdaManagement"
    effect    = "Allow"
    actions   = ["lambda:*"]
    resources = ["*"]
  }
```

> **This is the only change in all three PRDs that touches `terraform/` root.** The deployer cannot grant itself IAM, so an admin must `terraform apply` this locally with admin credentials **before** the `platform/0008` CD run — otherwise CD fails `AccessDenied` at `lambda:CreateFunction` (which is criterion §4.6's fail-closed proof, not a bug).

**b) `terraform/modules/messaging/` (queue + DLQ + topic + email subscription).** Variables: `name_prefix`, `name`, `notification_email`. Key resources:

```hcl
resource "aws_sqs_queue" "dlq" {
  name = "${var.name_prefix}-${var.name}-dlq"
}

resource "aws_sqs_queue" "this" {
  name                       = "${var.name_prefix}-${var.name}"
  visibility_timeout_seconds = 60   # ≥ 6× the worker's timeout (AWS guidance)
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sns_topic" "this" {
  name = "${var.name_prefix}-${var.name}"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.this.arn
  protocol  = "email"
  endpoint  = var.notification_email   # confirmation is a one-time inbox click, §9.2
}
```

Outputs: `queue_url`, `queue_arn`, `topic_arn`.

**c) `terraform/modules/lambda/` (function + exec role + event-source mapping).** Variables: `name_prefix`, `name`, `source_queue_arn`, `publish_topic_arn`, `handler`, `runtime` (default `nodejs20.x`), `filename`. The exec role carries `var` boundary and a customer-managed `soa-*` policy scoped to `source_queue_arn` (`sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`), `publish_topic_arn` (`sns:Publish`), and its own log group. Note for the applier:

```hcl
resource "aws_lambda_function" "this" {
  function_name = "${var.name_prefix}-${var.name}"
  role          = aws_iam_role.exec.arn
  runtime       = var.runtime
  handler       = var.handler
  filename      = var.filename   # committed placeholder on first apply; CD pushes real code
  timeout       = 10

  environment { variables = { TOPIC_ARN = var.publish_topic_arn } }

  # CD runs `aws lambda update-function-code` with the SHA-built zip after
  # apply (mirrors the ECR-first pattern in cd.yml), so Terraform must not
  # fight the code it pushes.
  lifecycle { ignore_changes = [filename, source_code_hash] }
}

resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn = var.source_queue_arn
  function_name    = aws_lambda_function.this.arn
  batch_size       = 10
}
```

**d) Wire into `terraform/app-base/main.tf`** (+ a `notification_email` variable in `variables.tf`, set via a tfvar — non-secret but an email address):

```hcl
module "notifications" {
  source = "../modules/messaging"

  name_prefix        = var.name_prefix
  name               = "notifications"
  notification_email = var.notification_email
}

module "notification_worker" {
  source = "../modules/lambda"

  name_prefix       = var.name_prefix
  name              = "notification-worker"
  handler           = "index.handler"
  filename          = "${path.module}/../../functions/notification-worker/bootstrap.zip"
  source_queue_arn  = module.notifications.queue_arn
  publish_topic_arn = module.notifications.topic_arn
}
```

Add to `app-base/outputs.tf`: `notifications_queue_url`, `notifications_queue_arn`, `notifications_topic_arn`.

**e) `terraform/app-edge/main.tf`** — add a local from remote state and pass it to the user service:

```hcl
# in locals { ... } alongside vpc_id etc.
  notifications_queue_url = data.terraform_remote_state.base.outputs.notifications_queue_url
  notifications_queue_arn = data.terraform_remote_state.base.outputs.notifications_queue_arn
```

and in `module "user_service"` (from [`user/0001`](../user/0001-user-service.md)): add `NOTIFICATIONS_QUEUE_URL = local.notifications_queue_url` to `env`, and `sqs_send_arns = [local.notifications_queue_arn]`.

**f) `terraform/modules/ecs-service/`** — new optional `variable "sqs_send_arns" { type = list(string), default = [] }`; in `main.tf`, when non-empty, add an `sqs:SendMessage` statement scoped to those ARNs to the task-role policy document. (The `soa-boundary` already permits `sqs:SendMessage`, so this stays within the ceiling.)

**g) `.github/workflows/ci.yml`** — after the docker-build loop, add a functions loop: for each `functions/<name>` (dir exists), `npm ci && npm test`. **h) `.github/workflows/cd.yml`** — after the ECR/build steps, for each `functions/<name>`: `npm ci --omit=dev`, `zip -r fn.zip .`; after `app-base` apply, `aws lambda update-function-code --function-name soa-<name> --zip-file fileb://fn.zip`; then a smoke step: `aws sqs send-message` a synthetic `UserProfileCreated` to the queue url (from `terraform output`) and `aws logs` tail/filter the worker's log group to assert an invocation.

**External references:** [Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html), [`aws_lambda_event_source_mapping`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_event_source_mapping), [SQS redrive/DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html), [SNS email subscription confirmation](https://docs.aws.amazon.com/sns/latest/dg/sns-email-notifications.html).

## 6. Scripts / commands

App code — run locally by agents, **nothing billable, nothing touching AWS**:

```bash
# 1. Lambda worker (app-engineer)
mkdir -p functions/notification-worker && cd functions/notification-worker
npm init -y && npm install @aws-sdk/client-sns
npm test                                   # handler formats + publishes (mocked)

# 2. User-service producer change (app-engineer)
cd services/user && npm install @aws-sdk/client-sqs && npm test   # incl. §4.2 case

# 3. No hardcoded endpoints (CI parity)
grep -rInE "elb\.amazonaws\.com" functions services/user          # must be empty

# 4. After the DevOps handoff lands — validate/plan ONLY, never apply
terraform -chdir=terraform/app-base validate
terraform -chdir=terraform/app-base plan     # expect messaging+lambda creates, 0 destroys
terraform -chdir=terraform/app-edge validate
terraform -chdir=terraform/app-edge plan     # user task role gains scoped sqs:SendMessage
```

Named human/admin action (DevOps, once):

```bash
# ADMIN ONLY — root identity, local admin creds. Must precede the 0008 CD run.
terraform -chdir=terraform validate
terraform -chdir=terraform plan              # expect: 1 change — deployer +lambda grant
terraform -chdir=terraform apply             # deliberate, named in this PRD
```

Post-merge verification (read-only / one send):

```bash
QURL=$(terraform -chdir=terraform/app-base output -raw notifications_queue_url)
# smoke send is done by CD; to reproduce, CD (not a human) runs:
#   aws sqs send-message --queue-url "$QURL" --message-body '{"type":"UserProfileCreated",...}'
aws logs filter-log-events --log-group-name "/aws/lambda/soa-notification-worker" --limit 5
```

**No `terraform destroy`, no resource deletion, and no hand-run service deploy is authorized.** The only `apply` a human runs is the root-identity one above; all app/base/edge applies are CD's.

## 7. Planned agents

| Step | Agent | Hands off |
| --- | --- | --- |
| This PRD | **main session** | The app specs (§3.1–§3.2) and the infra spec (§5.1) |
| `functions/notification-worker/` handler + tests | **app-engineer** | Green `npm test`; a handler resilient to one bad record |
| User-service producer change + test | **app-engineer** | The §4.2 publish-once-on-create test passing |
| `messaging` + `lambda` modules, `app-base`/`app-edge` wiring, `ecs-service` input | **terraform-engineer** *(DevOps)* | `validate`/`plan`, creates + 0 destroys |
| Root-identity `lambda:*` grant | **terraform-engineer** *(DevOps)* → **admin applies** | A 1-line plan; applied out-of-band before CD |
| `ci.yml` + `cd.yml` functions packaging + smoke test | **pipeline-engineer** *(DevOps)* | Zip-build + `update-function-code` + log-assert steps |
| Review before merge | **infra-reviewer** | Findings on the exec-role scoping, the deployer grant's blast radius, DLQ presence, cost, and that only `iam.tf` changed in root |
| Runbook + index updates | **documentation-keeper** | `async-messaging.md` and the README lines |

## 8. Testing / verification plan

| Criterion (§4) | How it is verified |
| --- | --- |
| 1 | `npm test` in `functions/notification-worker/` — jest with a mocked SNS client; includes a malformed-record case asserting no throw |
| 2 | `npm test` in `services/user/` — mocked SQS client; asserts `SendMessage` once on create, zero on the second `GET /users/me` against DynamoDB Local |
| 3, 5 | `terraform -chdir=terraform/app-base plan` — read the summary + the exec-role policy JSON; **infra-reviewer** confirms scoping and 0 destroys |
| 4 | `terraform -chdir=terraform/app-edge plan` — the user task policy diff shows scoped `sqs:SendMessage`; env shows `NOTIFICATIONS_QUEUE_URL` |
| 6 | `git diff terraform/iam.tf` is the single `lambda` statement; a CD run *before* the admin apply fails `AccessDenied` at `CreateFunction`; after it, succeeds |
| 7 | The grep in §6 step 3 |
| 8 | `aws logs filter-log-events` on the worker log group after CD's smoke send shows an invocation, no error |
| 9 | Manual browser end-to-end (recorded for the presentation): confirm the subscription once, register + first sign-in a fresh user, welcome email arrives |
| 10 | The redrive policy (`maxReceiveCount: 3` → DLQ) is present in the plan; the DLQ is a real queue |
| 11 | Index/runbook files exist and are linked |

**Infra-reviewer pass is mandatory before merge**, focused on: the Lambda exec role is boundary-carrying and triple-scoped (queue/topic/logs) with no wildcard; the deployer's `lambda:*` is the *only* root change and is acknowledged as broad-by-house-style; the DLQ exists; nothing billable slipped in.

## 9. Additional considerations

### 9.1 Security posture — the one root-identity change in the whole effort

- **The deployer gains `lambda:*`.** This is broad, but it mirrors the existing `sqs:*`/`sns:*`/`logs:*`/`cognito-idp:*` management grants — it is house style, not a new looseness class, and infra-reviewer may narrow it to the create/update/invoke/event-source-mapping subset. Critically, the deployer still **cannot escalate through it**: `iam:CreateRole` remains boundary-conditioned, so any Lambda exec role it mints is capped by `soa-boundary`, and the boundary grants a worker only `sqs:Receive*`/`sns:Publish`/`logs`/`cloudwatch:PutMetricData` — no data-plane reach into anyone's tables, no IAM.
- **This apply is human/admin, out-of-band.** The deployer cannot widen its own IAM (by design), so this cannot be pipeline-applied. It is the single hard dependency gating `platform/0008`, and it belongs to whoever holds AWS admin — the same identity that applied the original foundation ([operations/terraform-foundation.md](../../operations/terraform-foundation.md)). **If that person is unavailable, 0008 cannot deploy** — surface this early.
- **The producer's grant is minimal:** `sqs:SendMessage` scoped to one queue ARN, within the pre-existing boundary. The user service gains no other reach.
- **No secrets anywhere in this path** — queue URL and topic ARN are non-secret identifiers injected as env; the Lambda holds no credential (it uses its exec role).

### 9.2 The one manual step — subscription confirmation

SNS email subscriptions **cannot be fully automated**: Terraform creates a *pending* subscription and AWS emails a confirmation link that a human must click **once**. This is an inbox action, not console access, and is directly analogous to Cognito needing a real inbox ([`platform/0009` §9.3](0009-cognito-user-pool.md)). Consequence: **the first email cannot arrive until the `notification_email` recipient confirms.** The runbook must call this out, and the demo inbox should be confirmed well before the presentation. Until confirmed, the SQS→Lambda half still works and is provable via CloudWatch Logs (criterion §8) — only the final email hop waits on the click.

### 9.3 Rollback / teardown path

- **The entire async branch lives in `app-base`** — free and permanent. `terraform -chdir=terraform/app-edge destroy` does **not** touch it; the queue, topic, subscription and Lambda stay up at ~$0. Only the producer's `sqs:SendMessage` scope (in `app-edge`, on the user task role) comes and goes with the edge.
- Rolling back the worker's code is a redeploy of the previous SHA'd zip via `update-function-code`. Rolling back the whole feature is reverting the PR; the queue/topic can sit idle at $0. The `lambda:*` deployer grant can be reverted by re-applying root without it (admin action).
- **Poison messages** are contained by the DLQ (`maxReceiveCount: 3`) — a bad event can't hot-loop the Lambda or block the queue; it parks in `notifications-dlq` for inspection.

### 9.4 Dependencies, sequencing, timing

1. **Run order is fixed:** `platform/0009` (pool) → `user/0001` (service + the upsert seam the producer hooks) → **admin applies the `lambda:*` grant (§9.1)** → `platform/0008` merges and CD deploys. The producer change edits `services/user`, so 0008's app work presupposes 0001's code exists.
2. The `app-edge` `user_service` block will not plan until `platform/0008`'s `app-base` outputs (`notifications_queue_*`) exist — same remote-state ordering as every other base→edge dependency.
3. A **confirmed demo inbox** (§9.2) and Cognito's ~50/day email cap ([`platform/0009` §9.3](0009-cognito-user-pool.md)) both apply to the live demo — pre-stage a confirmed account and subscription.
4. **Reserved no longer:** this consumes the `platform/0008` slot both `order/0001` and `user/0001` pointed at. Order-confirmation email becomes `order/0002`, reusing this factory unchanged.

### 9.5 Rubric mapping

Directly satisfies the async criteria: "asynchronous via a message queue (SQS/SNS)", "SQS-triggered Lambda", "Lambda/SQS/SNS definitions", "test communication between microservices (including the SQS/Lambda path)", and CI/CD "packages to Lambda". Completes the hybrid-architecture story the other two PRDs leave open.

---

## Outcome

**Done — the async branch is built and deployed.** The full producer → SQS → Lambda → SNS path exists in `app-base` (free, permanent) and the user service publishes to it on first profile upsert. The only step outside code/infra is the one-time SNS email confirmation (§9.2), tracked as a to-do.

**What landed** (PRs #25 messaging factory, #27, #28 edge-wiring):
- **`terraform/modules/messaging/`** — `soa-notifications` SQS queue + `soa-notifications-dlq` (redrive `maxReceiveCount: 3`) + `soa-notifications` SNS topic + email subscription(s).
- **`terraform/modules/lambda/`** — `soa-notification-worker` (Node 20), its `soa-*-exec` role carrying **`soa-boundary`** and scoped to the queue (`Receive`/`Delete`/`GetQueueAttributes`), the topic (`Publish`), and its own log group; an `aws_lambda_event_source_mapping` from the queue.
- **`functions/notification-worker/`** — the handler (SQS event → format → `sns:Publish`), resilient to a malformed record, with tests.
- **user service as producer:** publishes `UserProfileCreated` on first `GET /users/me` upsert; task role gained `sqs:SendMessage` scoped to the one queue ARN (via the new `ecs-service` `sqs_send_arns` input); `NOTIFICATIONS_QUEUE_URL` injected.
- **CI/CD:** CI packages + tests `functions/*`; CD zips each function (SHA-tracked), applies, `aws lambda update-function-code`, and a smoke step publishes a synthetic event and asserts the invocation.
- **Docs:** `docs/operations/async-messaging.md` runbook.

**Deviations from plan:**
1. **The deployer `lambda:*` grant forced a policy consolidation.** Adding a separate `LambdaManagement` statement would have pushed the deployer's permissions policy past IAM's 6144-char limit, so the wildcard service statements were consolidated into a single `GlobalServiceManagement` (identical permissions, verified by `infra-reviewer`) with `lambda:*` added there. Still the only root-identity change, still admin-applied out-of-band ([to-do](../../to-dos/admin-apply-lambda-grant.md), now Done).
2. **Multi-recipient email.** The demo needed **two** notification addresses, so `NOTIFICATION_EMAIL` is comma-separated and the `messaging` module was extended to split it and create one `aws_sns_topic_subscription` per address (`for_each`) — a small superset of the single-subscription §5.1 spec.

**Verification:** function + user-service unit tests green; `plan` showed the queue/DLQ/topic/subscription/Lambda/exec-role/mapping as creates, 0 destroys; the exec role is boundary-carrying and triple-scoped (no wildcard); the user task policy gained only the scoped `sqs:SendMessage`. The SQS→Lambda→SNS half is provable via the worker's CloudWatch Logs (CD smoke send).

**Still tracked out-of-band (the final email hop):** both SNS email subscriptions are `PendingConfirmation` until someone clicks the AWS confirmation link — [`docs/to-dos/confirm-sns-subscription.md`](../../to-dos/confirm-sns-subscription.md). Until then, delivery to the inbox doesn't happen, but the rest of the path runs and is observable in logs. Order-confirmation email remains a future `order/0002` reusing this factory unchanged.
