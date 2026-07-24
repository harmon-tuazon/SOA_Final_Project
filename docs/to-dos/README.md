# Deployment To-Dos

> Pending manual, out-of-band, or deployment-gated actions a human must still perform. Governed by [`.claude/rules/deployment-todos.md`](../../.claude/rules/deployment-todos.md) — check this page before and after every merge/deploy.

## Pending

| To-do | Owner | When | Status |
| --- | --- | --- | --- |
| [Merge the stacked PRs in order](merge-stacked-prs-in-order.md) | repo owner | now → until all four PRs are merged | Pending |
| [Admin-apply the deployer `lambda:*` grant](admin-apply-lambda-grant.md) | AWS admin (console-only) | **BEFORE** merging the `platform/0008` messaging PR | Pending |
| [Set the `NOTIFICATION_EMAIL` Actions variable](set-notification-email-variable.md) | repo owner (GitHub UI) | before (or after) merging the `platform/0008` messaging PR | Pending |
| [Confirm the SNS email subscription](confirm-sns-subscription.md) | whoever owns the demo inbox | after the first `app-base` apply with `NOTIFICATION_EMAIL` set | Pending |
| [Create + confirm a demo Cognito account](create-demo-cognito-account.md) | repo owner / demo presenter | after `user/0001` deploys; well before the final presentation | Pending |

## Done

_None yet. Completed to-dos move here with their completion date — the file is kept as a record._
