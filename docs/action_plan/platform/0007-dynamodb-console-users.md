# 0007 — IAM Console Users (DynamoDB least-privilege + one admin)

> Create three IAM console users in the human-applied foundation: **two least-privilege** users who can view/edit data in the project's `soa-*` DynamoDB tables (but cannot create/alter/delete tables — that stays with the pipeline), and **one administrator** added to the existing `Admins` group (full `AdministratorAccess`, "same as the owner") with MFA enforced on that user. Scoped policies, MFA hard-enforced, explicit table-lifecycle deny for the data users. Human-applied `terraform/` root. ~$0 (IAM is free).

## 1. Status & metadata

- **Status:** Done
- **Date:** 2026-07-20
- **Author:** Harmon Tuazon
- **Approved:** 2026-07-20 (user)

> Decisions settled via `/grill-me`. Execution (a human `terraform apply` on the root, plus manual password setup) starts only after this PRD is marked **Approved**.

## 2. User story

As the platform owner, I want two teammates to have console access to **view and edit DynamoDB data** in the project's tables — inspecting orders, fixing a bad record, clearing test rows — **without** the ability to create, restructure, or delete tables, so that day-to-day data work is self-serve while all table lifecycle stays with the dedicated pipeline role and no one can accidentally (or maliciously) drop a table. Separately, I want one trusted co-owner to have **full administrator access** (same as me) so a second person can operate the account, with MFA enforced on that admin to limit takeover risk.

## 3. Scope

**In scope** — a new `terraform/console-users.tf` in the **human-applied root** config:
- **Two `aws_iam_user`** resources, names supplied via a `console_users` variable (a gitignored `tfvars` — real names never land in committed files). **No login profile** — passwords are set manually in the console (see §6).
- **One `aws_iam_group`** `soa-dynamodb-console`; both users are members (`aws_iam_user_group_membership`). Policies attach to the group.
- **A customer-managed data policy** (`soa-dynamodb-console-data`) allowing, scoped to `arn:aws:dynamodb:us-east-1:<acct>:table/soa-*` (+ `/index/*`):
  - **View:** `GetItem`, `BatchGetItem`, `Query`, `Scan`, `PartiQLSelect`, `ConditionCheckItem`, `DescribeTable`, `DescribeTimeToLive`, `DescribeContinuousBackups`, `ListTagsOfResource`.
  - **Edit (incl. row delete):** `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `PartiQLInsert`, `PartiQLUpdate`, `PartiQLDelete`.
  - **Console-support (account-level, can't be resource-scoped):** `dynamodb:ListTables`, `dynamodb:DescribeLimits`, `dynamodb:DescribeEndpoints` on `Resource = "*"` (lets the console render the table list; interaction is still `soa-*`-only).
- **An explicit table-lifecycle Deny** (in the same or a paired policy) on `soa-*`: `CreateTable`, `DeleteTable`, `UpdateTable`, `DeleteBackup`, `CreateBackup`, `RestoreTable*`, `CreateGlobalTable`, `UpdateGlobalTable`, `ImportTable`, `ExportTableToPointInTime`, `UpdateContinuousBackups`, `UpdateTimeToLive` — deny wins even if a broader policy is ever attached.
- **An MFA-enforcement policy** (`soa-console-enforce-mfa`, the canonical AWS pattern) attached to the group:
  - Allow each user to manage **their own** password + MFA device (scoped to `arn:…:user/${aws:username}` and `arn:…:mfa/${aws:username}`) and view account password policy / list virtual MFA devices.
  - **Deny everything else** when `aws:MultiFactorAuthPresent` is false — so data access is blocked until the user enrolls an MFA device on first login.
- **A `signin_url` output** (`https://<account-id>.signin.aws.amazon.com/console`) so the credential handoff is copy-paste. No account alias is set by default (optional follow-up).

**Plus one administrator user (the "same as owner" grant):**
- **One `aws_iam_user`** for the admin, name supplied via a separate `admin_console_users` variable (also gitignored). No login profile (manual password).
- **Membership in the existing `Admins` group** via `aws_iam_user_group_membership` (references `Admins` by name — `admin_group_name` variable, default `"Admins"`). This grants full `AdministratorAccess` (the policy already attached to that group). **Critically, `aws_iam_user_group_membership` is used — NOT `aws_iam_group_membership`** — so Terraform manages only *this user's* membership additively and can never remove the existing owner from `Admins`. The `Admins` group and its `AdministratorAccess` are left unmanaged (as they are today).
- **MFA enforced on the admin user only:** the same `soa-console-enforce-mfa` policy is attached directly to the admin's user (`aws_iam_user_policy_attachment`), so a leaked admin password alone can't act — deny-without-MFA + self-service enrollment. The owner's account and the `Admins` group are left untouched (owner MFA is a flagged follow-up, §9).

**Out of scope:**
- **Programmatic access / access keys** — console-only, no long-lived API keys.
- **`sts:AssumeRole` into any elevated/table-admin role** — users have no table-lifecycle path at all.
- **The `soa-boundary`** — it's a *workload* permission ceiling (permits `dynamodb:*`, SQS, etc.), the wrong fit for minimal human users; the scoped policy + explicit deny already deliver least-privilege. (A dedicated *user* boundary is a possible future follow-up.)
- **IAM Identity Center / SSO** — plain IAM users are simpler for two people; SSO (email invites) is a larger future option.
- **Setting the users' actual passwords in Terraform** — done manually so no secret enters state.

## 4. Success criteria

1. `terraform -chdir=terraform validate` passes with the new `console-users.tf`; a `plan` shows only the two users + group + memberships + policies to add (no changes to existing foundation resources).
2. The data policy is scoped to `table/soa-*` (+ `/index/*`) for all item/table-describe actions; only `ListTables`/`DescribeLimits`/`DescribeEndpoints` use `Resource="*"`.
3. **No table lifecycle:** the explicit Deny covers `CreateTable`/`DeleteTable`/`UpdateTable`/`DeleteBackup`/etc. on `soa-*`; `infra-reviewer` confirms deny-wins and that no statement grants those actions.
4. **MFA enforced:** the policy denies all actions (incl. DynamoDB) when `MultiFactorAuthPresent=false`, except the self-service MFA/password setup scoped to `${aws:username}`.
5. **No secrets/PII in committed files:** usernames come from a gitignored `tfvars` (`git status` shows it ignored); no password/login profile in Terraform; no real account ID/ARN hardcoded in the PRD.
6. **Functional (post-apply, manual):** each teammate signs in at the `signin_url` with their temp password, is forced to reset it, must enroll MFA before doing anything, then can **view + edit items** in a `soa-*` table in the console but gets **AccessDenied** attempting to create or delete a table.
7. **Admin user:** created and a member of `Admins` (effective `AdministratorAccess`); MFA enforced on his user (anything without an MFA-authenticated session → AccessDenied except MFA setup); `infra-reviewer` confirms membership uses `aws_iam_user_group_membership` (additive) and a `plan` never removes the owner from `Admins`.
8. **$0** — only IAM users/groups/policies are added; no billable resource.

## 5. Resources

| Resource | Type | Cost |
| --- | --- | --- |
| Two console users | `aws_iam_user` | **$0** |
| Console group | `aws_iam_group` + `aws_iam_user_group_membership` | **$0** |
| DynamoDB data policy (view+edit `soa-*`) | `aws_iam_policy` + `aws_iam_group_policy_attachment` | **$0** |
| Table-lifecycle Deny | `aws_iam_policy` stmt | **$0** |
| MFA-enforcement policy | `aws_iam_policy` | **$0** |
| `console_users` variable + gitignored tfvars | Terraform var / local file | **$0** |
| `signin_url` output | Terraform output | **$0** |
| Admin user | `aws_iam_user` | **$0** |
| Admin membership in existing `Admins` (additive) | `aws_iam_user_group_membership` | **$0** |
| MFA enforcement on admin | `aws_iam_user_policy_attachment` (reuses enforce-mfa policy) | **$0** |
| `admin_console_users` / `admin_group_name` variables | Terraform vars / local tfvars | **$0** |

**Total: $0.** IAM identities and policies are free; no compute, no data.

## 6. Scripts / commands

```bash
# --- Provide the usernames locally (gitignored) ---
#   terraform/console-users.auto.tfvars  (gitignored):
#     console_users       = ["<user-1>", "<user-2>"]   # DynamoDB least-privilege
#     admin_console_users = ["<admin-user>"]           # full admin (Admins group)

# --- Validate (terraform-engineer; no apply) ---
terraform -chdir=terraform validate
terraform -chdir=terraform plan            # expect: 2 users + group + memberships + policies to add

# --- Apply (HUMAN, admin creds — the deployer cannot create IAM users) ---
terraform -chdir=terraform apply           # creates users/group/policies
terraform -chdir=terraform output signin_url

# --- Manual, per user (HUMAN, IAM console) ---
#   IAM > Users > <user> > Security credentials > Console access:
#     enable, set a temporary password, check "user must reset at next sign-in".
#   Then hand each teammate (out-of-band): signin_url + username + temp password.
#   They sign in -> reset password -> enroll MFA (required) -> can use DynamoDB data.
```

The only billable/destructive command is `terraform -chdir=terraform apply` — and it adds only free IAM resources. No password is ever passed through Terraform.

## 7. Planned agents

- **`terraform-engineer`** — write `terraform/console-users.tf`: the `console_users` variable, two `aws_iam_user`s from it, the `soa-dynamodb-console` group + memberships, the scoped data policy, the explicit table-lifecycle Deny, the canonical MFA-enforcement policy (self-manage-own-MFA + deny-without-MFA), the group attachments, and the `signin_url` output. **Plus the admin user:** the `admin_console_users` + `admin_group_name` (default `"Admins"`) variables, an `aws_iam_user` for the admin, an **`aws_iam_user_group_membership`** adding him to `Admins` (NOT `aws_iam_group_membership` — must not touch the owner's membership), and an `aws_iam_user_policy_attachment` binding the enforce-MFA policy to the admin's user. Add `*.auto.tfvars`/`console-users*.tfvars` to `.gitignore` if not already covered. `fmt`/`validate`/`plan`; confirm the `plan` shows **only additions** (no removal of any existing `Admins` membership); **never apply**.
- **`infra-reviewer`** — audit: data policy scoped to `soa-*` (only list/describe-limits on `*`), no table-lifecycle granted + explicit deny effective, MFA enforced correctly (self-service scoped to `${aws:username}`), no access keys, no secrets/PII committed, no over-broad IAM.
- **`documentation-keeper`** — a short `docs/operations/dynamodb-console-access.md`: who the users are (by role, not naming individuals), what they can/can't do, the sign-in + MFA-enrollment steps, and the "new tables go through the pipeline" note. Link from `terraform-foundation.md`.
- **Main session** — writes this PRD; sets the gitignored `tfvars` with the two usernames; drives the human `terraform apply` + the per-user console password setup + credential handoff.

## 8. Testing / verification plan

| Criterion | Verification |
| --- | --- |
| #1 validate/plan | `terraform -chdir=terraform validate`; `plan` shows only the additive users/group/policies |
| #2 scope | read the policy: item/describe actions on `table/soa-*`; only list/limits on `*` |
| #3 no table ops | `infra-reviewer` confirms explicit Deny + no grant of Create/Delete/UpdateTable |
| #4 MFA | `infra-reviewer` confirms deny-without-MFA + `${aws:username}`-scoped self-service |
| #5 no secrets/PII | `git check-ignore` the tfvars; grep committed files for the names/account id → none |
| #6 functional | sign in as a user: MFA required; view+edit a `soa-*` item works; create/delete table → AccessDenied |
| #7 $0 | plan/apply adds only IAM resources |

## 9. Additional considerations

- **Deliberate exception to the keyless posture:** the project avoids long-lived credentials *for automation* (OIDC everywhere). Human console access genuinely needs a login, so two IAM users with console passwords + enforced MFA is the right, scoped exception — not a regression. No access keys are issued, so there's still no long-lived programmatic secret.
- **The admin user is full root-equivalent — deliberately.** Adding the admin to `Admins` grants `AdministratorAccess`: they can do *anything*, including deleting infrastructure, modifying/deleting IAM (the deployer, the boundary, these very users), and touching billing. This intentionally bypasses every least-privilege guardrail in the project — it's the "trusted co-owner" grant, confirmed by the owner, not a least-privilege identity. It sits deliberately apart from the two scoped DynamoDB users in the same file.
- **Membership safety:** the admin is added with **`aws_iam_user_group_membership`** (manages only that user's memberships, additively), never `aws_iam_group_membership` (which owns a group's *entire* member list and would remove the existing owner from `Admins` on apply). The `Admins` group + its `AdministratorAccess` remain unmanaged by this config.
- **Admin MFA enforced; owner MFA is an open gap.** MFA is enforced on the new admin's user (deny-without-MFA). The owner's own account currently has **no MFA** and is unchanged by this PRD (per the owner's choice) — flagged as a real, recommended follow-up: two full-admin accounts should both have MFA, so enrolling MFA on the owner account (and/or enforcing it on the `Admins` group) closes the largest remaining takeover risk.
- **Human-applied, like the rest of the identity foundation:** `soa-deployer` cannot create IAM users (its `iam:Create*` is scoped to roles/policies, not users), so this is applied by a human with admin creds against `terraform/` root — same path as the deployer/boundary. The pipeline never touches it.
- **`ListTables` visibility:** the console will list *all* table names in the account (AWS can't resource-scope `ListTables`), but users can only open/edit `soa-*` ones. Table names aren't sensitive.
- **PII / names:** the two usernames live only in a gitignored `tfvars`; committed Terraform uses `var.console_users` and the PRD/docs name people by role, not identity.
- **Rollback/teardown:** removing the block (or `terraform destroy`-targeting the users) deletes the users/group/policies — free and reversible. This is **not** part of the routine `app-edge` teardown; it's permanent foundation like the other identities.
- **Follow-ups:** a dedicated *user* permissions boundary; an account alias for a friendlier sign-in URL; IAM Identity Center if the team grows; extending the same group pattern to other read/edit scopes later.

---

## Outcome

Executed and applied. The Terraform (`terraform/console-users.tf`) was human-applied against the root identity config (`terraform -chdir=terraform apply`) → **12 added, 0 changed, 0 destroyed**.

**Delivered:**
- Two least-privilege DynamoDB data users in the `soa-dynamodb-console` group (scoped `soa-*` view/edit incl. row delete, explicit table-lifecycle Deny, MFA enforced on the group).
- One admin user added to the pre-existing `Admins` group (full `AdministratorAccess`) via `aws_iam_user_group_membership` (additive), with MFA enforced directly on the admin's user.
- `soa-console-enforce-mfa` policy (canonical self-service + deny-without-MFA), `signin_url` output, gitignored `console-users.auto.tfvars` for the real names (never committed), committed `.tfvars.example`. Docs: `operations/console-access.md`.

**Verification:**
- infra-reviewer verdict **safe to apply** — all six checks passed against the real account (least-privilege `soa-*` scope, table-op deny effective, MFA non-locking + `${aws:username}`-scoped, no keys/secrets/PII, foundation untouched). Cleaned up one dead `sts:GetSessionToken` scope it flagged.
- Post-apply `aws iam get-group` confirms **`Admins` = {owner, new admin}** (owner intact — the additive-membership safeguard held), the two data users are in `soa-dynamodb-console`, and all three users exist. `$0` (IAM only).

**Owner's remaining operational steps (out-of-band, not IaC):** set a temp console password per user (IAM console, force reset), then hand each teammate the `signin_url` + username + temp password; on first login they reset the password and must enroll MFA before any access works.

**Deviation (approved):** the third, full-admin user was added mid-flight at the owner's request — the PRD was amended and re-confirmed before the build. The scoped grant for the two data users was unaffected.

**Follow-up (flagged):** the account **owner's own IAM user has no MFA** and was intentionally left unchanged; enrolling MFA on it (or enforcing MFA on the `Admins` group) is the recommended next step to close the largest remaining account-takeover risk.
