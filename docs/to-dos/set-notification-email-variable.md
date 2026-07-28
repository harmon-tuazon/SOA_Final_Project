# Set the `NOTIFICATION_EMAIL` Actions variable

- **Status:** Pending
- **Owner:** repo owner (GitHub UI — repository admin access)
- **When:** before (or any time after) merging the `platform/0008` messaging PR. The Terraform is written to fail soft: while the variable is unset/empty, the SNS **email subscription is simply not created** — everything else (queue, DLQ, topic, Lambda) deploys and works, and the path is still provable via CloudWatch Logs. Setting the variable later just adds the subscription on the next CD run.
- **Source:** [PRD platform/0008 §5.1](../action_plan/platform/0008-messaging-factory.md) — `notification_email` variable on `terraform/app-base/`.
- **Verification:** the next *Infrastructure CD* run's `app-base` apply shows `aws_sns_topic_subscription` created; then [confirm the subscription](confirm-sns-subscription.md).

## Steps

1. Decide the demo/notification inbox — a real mailbox someone on the team can open (it will receive the SNS confirmation link and every welcome email). A personal address is fine for the course demo; it lives only in GitHub settings, never in the repo.
2. GitHub → the repository → **Settings → Secrets and variables → Actions → Variables tab → New repository variable**:
   - **Name:** `NOTIFICATION_EMAIL`
   - **Value:** the chosen address
   (It's a *variable*, not a secret, consistent with how `AWS_REGION`/`TF_STATE_BUCKET` are stored — an email address is an identifier, not a credential. Using a secret would also work but breaks the convention.)
3. If `platform/0008` is already merged, re-run the latest *Infrastructure CD* workflow (Actions → Infrastructure CD → **Re-run all jobs**) — or just let the next push to `main` pick it up.
4. Mark this to-do **Done** (date it) and move its line to the Done section of [README.md](README.md). The follow-on to-do is [confirm-sns-subscription.md](confirm-sns-subscription.md).
