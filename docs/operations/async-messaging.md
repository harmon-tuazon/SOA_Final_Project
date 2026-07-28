# Async Messaging: SQS → Lambda → SNS

How the event-driven half of the architecture works — the reusable `messaging`/`lambda` module pair, the one concrete pipeline built on it (user-signup notifications), how its code deploys, and how to operate/debug it. Built by [PRD platform/0008](../action_plan/platform/0008-messaging-factory.md); decision context in [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) (the hybrid containers + event-driven serverless split) and [ADR 0003](../architecture/decisions/0003-base-edge-split.md) (why this lives in the permanent config).

Config/module sources: [`terraform/modules/messaging/`](../../terraform/modules/messaging/) (queue + DLQ + topic + email subscription), [`terraform/modules/lambda/`](../../terraform/modules/lambda/) (function + exec role + event source mapping — see PRD platform/0008 §5.1 for the spec if the module isn't wired yet in your checkout), wired into [`terraform/app-base/main.tf`](../../terraform/app-base/main.tf) as `module "notifications"` + `module "notification_worker"`. Worker source: [`functions/notification-worker/`](../../functions/notification-worker/).

## 1. The shape

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
(adapted from [PRD platform/0008 §3.2](../action_plan/platform/0008-messaging-factory.md#32-the-path))

**Everything except the producer's permission lives in `app-base`** — the permanent, free half of the [base/edge split](../architecture/decisions/0003-base-edge-split.md):

- The queue, DLQ, topic, email subscription (`modules/messaging`), the Lambda function, its execution role, and the SQS event source mapping (`modules/lambda`) are all declared in `terraform/app-base/main.tf`. They are event-driven and free-tier (see [PRD platform/0008 §5](../action_plan/platform/0008-messaging-factory.md#5-resources) for the per-resource cost table), so there's no reason to churn them with the billable `app-edge` teardown/spin-up cycle — a `terraform -chdir=terraform/app-edge destroy` between sessions ([cost-lifecycle.md](cost-lifecycle.md)) does not touch any of it.
- The **only** piece of this pipeline that lives in `app-edge` is the producer's own grant: the user service's ECS task role gains a scoped `sqs:SendMessage` on the notifications queue ARN (an `ecs-service` module input, `sqs_send_arns`), and the queue URL is injected into its container as `NOTIFICATIONS_QUEUE_URL`. That grant comes and goes with the edge like the rest of the user service's compute, but the queue itself doesn't — a producer redeployed after a teardown just resumes sending to the same, still-standing queue.

Don't look here for concrete ARNs, queue/topic names, timeout values, or batch sizes — those live in and can drift in the Terraform modules linked above. This doc explains why the pieces are split this way and how they fit together.

## 2. The event contract

The one event type in flight today is `UserProfileCreated`, published as JSON to the notifications queue by the user service on a user's first lazy profile upsert (`GET /users/me`):

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | `"UserProfileCreated"` — the extension point: the worker branches on this field, so new event types (see below) don't need a new queue/topic/Lambda, just a new `type` value the handler learns to format |
| `userId` | string | the Cognito `sub` |
| `email` | string | from the verified token claim — the welcome email's recipient context |
| `displayName` | string? | if the profile carried one |
| `occurredAt` | string | ISO-8601, set by the producer |

The worker formats a welcome subject/message from this and calls `sns:Publish` on the notifications topic; SNS fans out to the confirmed email subscription.

**This factory is designed to be reused, not rebuilt, for the next event.** An order-confirmation email is the planned second producer (a future `order/0002` PRD, referenced from [`order/0001`](../action_plan/order/0001-service-scaffold.md) and reserved in [PRD platform/0008 §9.4](../action_plan/platform/0008-messaging-factory.md#94-dependencies-sequencing-timing)): it will publish its own event `type` onto this same notifications queue rather than standing up a second queue/topic/Lambda, and the worker gains a second `formatX()` branch.

## 3. How code deploys

The worker's code is **not** zipped and pushed by CI/CD the way service images are. Terraform itself packages `functions/notification-worker/index.js` via an `archive_file` data source, and the resulting `source_code_hash` is what tells `aws_lambda_function` a new deploy is needed — so **a code change to the handler redeploys on the next `app-base` apply**, with no separate `aws lambda update-function-code` step and no bundling. This works because the `nodejs20.x` Lambda runtime already bundles the AWS SDK v3: `@aws-sdk/client-sns` is a `devDependency` only (used to run the unit tests locally), never a runtime `dependency`, and the packaged artifact is just `index.js` — nothing from `node_modules` ships. See the packaging-rationale comment in [`functions/notification-worker/index.js`](../../functions/notification-worker/index.js) and its [README](../../functions/notification-worker/README.md#why-aws-sdkclient-sns-is-a-devdependency-only).

CI (`ci.yml`) runs each function's `jest` suite (`npm ci && npm test` per `functions/<name>/`) on every PR — the same gate every service gets, generalized to the `functions/` convention. See [`functions/notification-worker/tests/handler.test.js`](../../functions/notification-worker/tests/handler.test.js).

## 4. Operating it

**Logs:** `/aws/lambda/<name_prefix>-notification-worker` in CloudWatch Logs (the exact log group name comes from `name_prefix`, set in Terraform — don't hardcode it; read it with `terraform -chdir=terraform/app-base output` or from the console). Every invocation, including a skipped malformed/unknown-type record, logs a line.

**CD smoke test:** after every deploy, CD publishes a synthetic `UserProfileCreated` message directly to the queue and checks the worker's CloudWatch Logs for an invocation with no error — proving the SQS→Lambda hop end-to-end on every merge. **It deliberately does not assert that an email arrives** — the email hop depends on a human having confirmed the SNS subscription (§5 below), which CD cannot do and must not block on. A green smoke test means the queue-to-Lambda path works; it says nothing about whether the confirmed-subscriber inbox is wired up yet.

**Dead-letter queue:** `notifications-dlq`, fed by the main queue's redrive policy at `maxReceiveCount: 3` — a message the worker fails to process (reports as a batch item failure) three times lands here instead of retrying forever or blocking the queue. Inspecting or redriving a parked message is a manual, console/CLI action (`aws sqs receive-message` / the SQS console's "Start DLQ redrive" — there is no automation for this, on purpose: a poison message deserves a human look, not silent replay).

**Partial-batch-failure semantics:** the worker returns `batchItemFailures` (the [SQS partial-batch-failure convention](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting)), scoped per-record within a batch:

- A record whose body **isn't valid JSON** is logged and **skipped** — never retried, never reported as a failure. Retrying an unparseable record can't ever succeed, so reporting it as a failure would just spin it through the queue until `maxReceiveCount` parks it in the DLQ for no useful reason; skipping it silently (but with a log line) is the deliberate choice. It is **not** what sends a message to the DLQ — only repeated genuine processing failures do that (see below).
- A record with an unrecognised `type` is likewise logged and skipped — forward-compatible with a producer emitting an event type this build of the worker doesn't know yet.
- A record that parses and has a known `type`, but whose `sns:Publish` call itself fails, **is** reported as a batch item failure — only that record is retried by SQS, and after three failed attempts it's the one that reaches the DLQ.

See [`functions/notification-worker/index.js`](../../functions/notification-worker/index.js) for the implementation and [its README](../../functions/notification-worker/README.md) for the full behavior table.

## 5. Manual gates

Three steps in this pipeline cannot be automated and are tracked as [to-dos](../to-dos/README.md):

1. **[Admin-apply the deployer `lambda:*` grant](../to-dos/admin-apply-lambda-grant.md)** — `soa-deployer` cannot modify its own IAM ([ADR 0002](../architecture/decisions/0002-terraform-configuration-topology.md)), so a human with admin credentials must apply the `LambdaManagement` statement in `terraform/iam.tf` **before** the first CD run that creates `soa-notification-worker`. Until this lands, CD fails closed with `AccessDenied` on `lambda:CreateFunction` — that's the boundary working as designed, not a bug.
2. **[Set the `NOTIFICATION_EMAIL` Actions variable](../to-dos/set-notification-email-variable.md)** — while unset/empty, `app-base`'s plan is written to skip creating the SNS email subscription entirely (`count = 0` in `modules/messaging`); the queue, DLQ, topic, and Lambda still deploy and work. Setting the variable adds the subscription on the next apply.
3. **[Confirm the SNS email subscription](../to-dos/confirm-sns-subscription.md)** — SNS email subscriptions are double opt-in by AWS design: Terraform can only create a *pending* subscription, and AWS emails the endpoint a one-time confirmation link a human must click.

**Until that click happens, only the final email hop is missing** — the SQS→Lambda half already works and is provable via CloudWatch Logs regardless of subscription state (see [PRD platform/0008 §9.2](../action_plan/platform/0008-messaging-factory.md#92-the-one-manual-step--subscription-confirmation)). Don't treat a missing email as evidence the pipeline is broken; check the log group first.

## 6. Security posture

(From [PRD platform/0008 §9.1](../action_plan/platform/0008-messaging-factory.md#91-security-posture--the-one-root-identity-change-in-the-whole-effort).)

- **The worker's execution role is boundary-carrying and triple-scoped:** it carries `soa-boundary` and its customer-managed policy grants exactly `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes` on its own queue, `sns:Publish` on its own topic, and write access to its own log group — nothing account-wide, no AWS-managed policy, no inline policy.
- **The producer's grant is equally narrow:** the user service's task role gains `sqs:SendMessage` scoped to the one notifications queue ARN, nothing else.
- **No secrets anywhere in this path.** The queue URL and topic ARN are non-secret identifiers injected as plain env vars; the Lambda authenticates via its execution role, not a credential.
- The one broad grant in this whole effort — `soa-deployer` gaining `lambda:*` — is on the **deployer**, not the workload, and is still capped: the deployer's `iam:CreateRole` remains boundary-conditioned, so any exec role it mints for a Lambda is capped by `soa-boundary` regardless. See §5 above for the human step this requires.

## Related docs

- [PRD platform/0008](../action_plan/platform/0008-messaging-factory.md) — the plan, scope, and (once filled in) outcome for this pipeline.
- [ADR 0001](../architecture/decisions/0001-platform-and-compute-architecture.md) — why the architecture splits sync (ECS) from async (SQS/Lambda/SNS) work in the first place.
- [ADR 0003](../architecture/decisions/0003-base-edge-split.md) — why this pipeline lives entirely in the permanent `app-base` config (bar the producer's `app-edge` grant).
- [architecture/overview.md](../architecture/overview.md) — where this fits in the system's overall shape.
- [cost-lifecycle.md](cost-lifecycle.md) — why `app-edge` teardown never touches this pipeline.
- [cicd-pipeline.md](cicd-pipeline.md) — how `ci.yml`/`cd.yml` build, test, and apply the app tier this pipeline is part of.
- [`docs/to-dos/README.md`](../to-dos/README.md) — the live checklist of the manual gates in §5.
