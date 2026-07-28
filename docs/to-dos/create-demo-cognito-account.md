# Create + confirm a demo Cognito account

- **Status:** Pending
- **Owner:** repo owner / whoever presents the final demo
- **When:** after `user/0001` is deployed (SPA auth live) — and **well before the final presentation**, so the live demo never depends on real-time email delivery in front of an audience.
- **Source:** [PRD user/0001 §9.4](../action_plan/user/0001-user-service.md), [PRD platform/0009 §9.3](../action_plan/platform/0009-cognito-user-pool.md).
- **Verification:** signing in with the demo account in the SPA loads the profile page; a saved billing profile persists across a sign-out/sign-in.

## Why this is a to-do

Registration requires a **real inbox** to receive Cognito's 6-digit confirmation code, and Cognito's built-in email sender is capped (~50/day) and can land in spam — none of which you want to be debugging live. Pre-staging one confirmed account makes the presentation deterministic; a second, fresh registration can still be demonstrated live as the risky-but-impressive path.

## Steps

1. Open the SPA (the S3 website URL) → **Register** with a real inbox you control and a password meeting the policy (8+ chars, upper, lower, number).
2. Retrieve the 6-digit code from the inbox (**check spam**) and complete the confirm step in the SPA.
3. Sign in. Open the profile page (this first authenticated call creates the profile row — and, once `platform/0008` is live, triggers the welcome email).
4. Fill in a display name and a billing profile (use obviously fake data — the API rejects real card numbers by design).
5. Sign out, sign back in, and verify everything persisted. Note the credentials somewhere appropriate for the team (a password manager — **not** this repo).
6. Mark this to-do **Done** (date it) and move its line to the Done section of [README.md](README.md).
