# Merge the stacked PRs in order

- **Status:** Done (2026-07-28)
- **Owner:** repo owner (GitHub UI)
- **When:** now — this is the execution sequence for the three approved PRDs ([platform/0009](../action_plan/platform/0009-cognito-user-pool.md) → [user/0001](../action_plan/user/0001-user-service.md) → [platform/0008](../action_plan/platform/0008-messaging-factory.md)).
- **Source:** the run-order constraints in each PRD's §9 (remote-state dependencies + the deployer IAM gate).
- **Verification:** after the last merge, *Infrastructure CD* is green and the welcome-email path works end to end.

> **Done (2026-07-28):** the whole stack merged in order on 2026-07-28 — docs/PRDs (#20), Cognito `platform/0009` (#21), `user/0001` (#22), messaging base `platform/0008` (#25/#27), and the messaging edge-wiring (#28) — each after its predecessor's CD went green. CD is green on `main`. (Tracker mark re-applied 2026-07-28.)

## Why the order is fixed

Each later branch **stacks on** the earlier one (they edit the same files), and each later config **reads the earlier one's Terraform state**: `user/0001`'s `app-edge` plan needs the Cognito outputs that only exist after 0009's `app-base` **applies** (CD, on merge), and 0008's edge wiring needs the queue outputs from 0008's own base apply. CI on a stacked PR therefore fails on a missing remote-state output until its predecessor has merged **and CD has finished** — that is expected, not a bug.

## Steps

1. **Merge the PRDs/docs PR** (docs-only; CD does not trigger on it).
2. **Merge the `platform/0009` PR** (Cognito pool). Wait for *Infrastructure CD* on `main` to go green.
3. On the `user/0001` PR: **update the branch / re-run CI** (it now finds the Cognito outputs in state), mark it ready for review if still draft, and **merge**. Wait for CD green — this deploys `soa-user` and the SPA auth.
   → then do [create-demo-cognito-account.md](create-demo-cognito-account.md).
4. **BEFORE step 5:** the AWS admin performs [admin-apply-lambda-grant.md](admin-apply-lambda-grant.md), and set [`NOTIFICATION_EMAIL`](set-notification-email-variable.md) (can also be done later — fails soft).
5. **Merge the `platform/0008` (messaging base) PR** after re-running its CI. Wait for CD green — this creates the queue/topic/Lambda.
   → then do [confirm-sns-subscription.md](confirm-sns-subscription.md).
6. **Merge the `platform/0008` edge-wiring PR** after re-running its CI. Wait for CD green — the user service now publishes events, and a first sign-in sends a welcome email.
7. Mark this to-do **Done** (date it) and move its line to the Done section of [README.md](README.md); update each PRD's Status/Outcome as its piece lands.
