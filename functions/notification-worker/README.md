# notification-worker

Lambda worker: the consumer half of the async notification pipeline built by
[PRD platform/0008](../../docs/action_plan/platform/0008-messaging-factory.md).
SQS-triggered (batch), formats a welcome notification, and publishes it to
SNS for fan-out to the confirmed email subscription.

## What it does

For each record in an SQS event batch:

1. `JSON.parse` the message body. A malformed (non-JSON) body is
   `console.warn`'d and **skipped** — never thrown, never retried, and never
   reported as a batch item failure, so a single poison message can't loop
   forever (its containing queue's own `maxReceiveCount` redrive to the DLQ
   handles that case, not this handler).
2. An unrecognised `type` is likewise warned and skipped (forward-compatible
   with future event types this worker doesn't know about yet).
3. A valid `UserProfileCreated` event is formatted into a welcome
   subject/message and published via `sns:Publish` to `process.env.TOPIC_ARN`.
4. If the SNS publish itself fails, that record's `messageId` is reported in
   `batchItemFailures` (the [SQS partial-batch-failure
   convention](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting))
   so only that record is retried by SQS — the rest of the batch is
   unaffected and is never re-delivered.

## Event contract (PRD §3.1) — `UserProfileCreated`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | `"UserProfileCreated"` — lets the worker branch as more event types arrive |
| `userId` | string | the Cognito `sub` |
| `email` | string | from the verified token claim — the welcome email's recipient context |
| `displayName` | string? | if the profile carried one; falls back to `email` in the greeting |
| `occurredAt` | string | ISO-8601, set by the producer |

Published by `services/user`'s `src/events.js` (see that service's README).

## Config (env vars)

| Var | Required | Purpose |
| --- | --- | --- |
| `TOPIC_ARN` | yes | The SNS topic to publish the welcome notification to. Injected by Terraform (`terraform/modules/lambda`). |

## Why `@aws-sdk/client-sns` is a devDependency only

The `nodejs20.x` Lambda runtime bundles the AWS SDK v3 already, so
`@aws-sdk/client-sns` is listed under `devDependencies` (used only to run the
unit tests locally) and is **not** shipped in the deploy artifact — the
deploy zip CD builds is just `index.js` (plus `package.json` for metadata),
nothing from `node_modules` is bundled.

## Tests

```bash
npm install
npm test
```

`tests/handler.test.js` mocks `@aws-sdk/client-sns` (no AWS credentials or
network needed) and covers: a valid event publishing exactly once, a
malformed record being skipped without throwing, a mixed batch, an SNS
publish rejection reporting only the failed `messageId`, and an unknown
`type` being skipped.
