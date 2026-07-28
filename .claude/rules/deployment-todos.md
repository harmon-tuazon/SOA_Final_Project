# Deployment To-Dos Rule

Some actions required to make a change fully live **cannot be executed from this repo**: admin-credentialed Terraform applies on the root identity config, inbox confirmation clicks (SNS subscriptions, Cognito codes), GitHub repository settings (Actions variables, branch protection), or anything gated on a deployment having already happened. These must never live only in a PR description or a chat transcript — they are recorded as **to-do docs under `docs/to-dos/`** in the same PR that creates the need.

## Purpose

A PR can merge and CD can go green while the feature is still not actually working, because a human step is pending. The to-dos folder is the single place to look to answer: *"what must a human still do, when, and how do we know it's done?"*

## What qualifies

Record a to-do when an action is:

- **Out-of-band** — needs credentials, an inbox, or a console/UI this repo's pipeline doesn't have (admin `terraform apply` on `terraform/` root, clicking an SNS/Cognito confirmation link, setting a GitHub Actions variable);
- **Deployment-gated** — can only happen at or after a specific merge/apply (smoke-checking a live endpoint, confirming a subscription that only exists after apply, pre-staging demo data);
- **Ordering-critical** — must happen *before* a specific merge or the pipeline fails (e.g. an IAM grant the deployer needs before CD can create a resource).

Routine pipeline work, code review, and anything CD does automatically do **not** belong here.

## Location & structure

```
docs/to-dos/
├── README.md              # index: one line per to-do, with status — the page to check
└── <short-kebab-title>.md # one file per to-do
```

Every to-do file starts with an H1 title and this metadata block:

```markdown
- **Status:** Pending | Blocked | Done (YYYY-MM-DD)
- **Owner:** who must do it (role, not personal data — e.g. "AWS admin", "repo owner")
- **When:** the gate — e.g. "BEFORE merging PR X", "after the first `app-base` apply that creates Y"
- **Source:** link to the PRD/ADR/PR that created the need
- **Verification:** the command or observation that proves it's done
```

followed by the concrete steps, written for someone who has only the stated access (e.g. console-only steps for a console-only owner).

## Conventions

- **Create the to-do in the same PR** that introduces the need — a reviewer should reject a PR that requires a manual step but doesn't document it here.
- **Completing a to-do:** set `Status: Done (date)`, note anything that deviated, and move its index line to the Done section of `README.md`. Files are kept, not deleted — they double as a record of out-of-band actions taken against the AWS account.
- **No secrets, credentials, real account IDs, or ARNs** — same rule as all docs. Name SSM parameters / GitHub variables by name only.
- Cross-link: the PRD that spawns a to-do links to it, and vice versa.
- The `documentation-keeper` agent treats `docs/to-dos/` as part of the docs taxonomy (see [`documentation.md`](documentation.md)); any agent or session that plans work requiring a manual step **must** write the to-do rather than assuming someone will remember.
