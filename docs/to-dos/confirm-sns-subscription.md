# Confirm the SNS email subscription

- **Status:** Pending
- **Owner:** whoever owns the inbox set as `NOTIFICATION_EMAIL` (see [set-notification-email-variable.md](set-notification-email-variable.md))
- **When:** after the first `app-base` apply that creates the subscription (the first CD run on `main` with `NOTIFICATION_EMAIL` set). Until confirmed, **no notification email is delivered** — the SQS → Lambda half still works and logs to CloudWatch; only the final email hop waits on this click.
- **Source:** [PRD platform/0008 §9.2](../action_plan/platform/0008-messaging-factory.md).
- **Verification:** the AWS "Subscription confirmed" page loads after clicking the link; the next `UserProfileCreated` event (or CD smoke send) produces a real email in the inbox.

## Why this can't be automated

SNS email subscriptions are double-opt-in by AWS design: Terraform can only create the subscription in *PendingConfirmation* state, and AWS emails the endpoint a confirmation link that a human must click **once**. This is an inbox action — no console or AWS credentials involved.

## Steps

1. After the CD run that created the subscription, open the `NOTIFICATION_EMAIL` inbox.
2. Find the email from **AWS Notifications** (`no-reply@sns.amazonaws.com`), subject "AWS Notification - Subscription Confirmation". **Check spam** — it lands there often.
3. Click **Confirm subscription**. A browser page confirms it. That's it — the link is single-use and the confirmation survives every `app-edge` teardown (the topic lives in `app-base`).
4. Do **not** click "unsubscribe" links in later notification emails during the demo period — that undoes this step.
5. Mark this to-do **Done** (date it) and move its line to the Done section of [README.md](README.md).
