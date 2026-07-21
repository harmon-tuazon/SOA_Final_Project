# IAM Console Access

Who can sign into the AWS Console, what each access level can do, and how to get a new person set up. Covers [PRD platform/0007](../action_plan/platform/0007-dynamodb-console-users.md); provisioned by [`terraform/console-users.tf`](../../terraform/console-users.tf) in the human-applied identity foundation (see [terraform-foundation.md](terraform-foundation.md)).

## 1. Two access levels

This project issues plain IAM users for console sign-in — no access keys, no programmatic credentials. There are two distinct levels, described here by role, never by name:

| Level | Who | Can do | Can't do |
| --- | --- | --- | --- |
| **DynamoDB data user** | Teammates who need to inspect/fix data day-to-day | View and edit items (including deleting rows) in `soa-*` DynamoDB tables via the console | Create, restructure, or delete a table, its backups, or its TTL/replica settings |
| **Administrator** | One trusted co-owner | Everything — full `AdministratorAccess`, same as the account owner | Nothing is restricted; this is a deliberate full-trust grant |

Both levels are enforced to require MFA before they can do anything else (§4).

## 2. What the DynamoDB data users can and can't do

Scoped to tables named `soa-*` (this project's naming convention — see [`.claude/rules/service-contract.md`](../../.claude/rules/service-contract.md)):

- **View:** read items and query/scan a table, see its description, TTL, continuous-backups setting, and tags.
- **Edit:** create, update, and delete individual items/rows (`PutItem`, `UpdateItem`, `DeleteItem`, batch and PartiQL equivalents).
- **Console listing:** `dynamodb:ListTables` is granted account-wide because AWS cannot scope that action to a name pattern — so the console's table list will show every table in the account, not just `soa-*` ones. Opening or editing any non-`soa-*` table is still denied; table *names* aren't considered sensitive.
- **No table lifecycle, ever:** an explicit `Deny` blocks `CreateTable`, `DeleteTable`, `UpdateTable`, backup/restore, global-table, import/export, TTL, and replica actions on `soa-*` tables. IAM evaluates an explicit Deny before any Allow, so this holds even if a broader policy is ever attached to the group by mistake.
- **New tables come through the pipeline, not the console.** A new table is provisioned the same way every service's table is: via `/new-service` (or the manual recipe) adding a `data` module block to `terraform/app-base/main.tf`, applied by CI/CD — see [adding-a-service.md](adding-a-service.md). Data users have no path to create one themselves.
- **No access keys, no `AssumeRole` into anything more privileged** — console-only, and there is no elevated role for these users to assume.

Source of truth for the exact actions and scoping: [`terraform/console-users.tf`](../../terraform/console-users.tf) (`aws_iam_policy_document.dynamodb_console_data`).

## 3. Signing in for the first time

The account owner (whoever holds admin credentials) hands out access; AWS does not email anything for IAM users, so credentials are always distributed out-of-band (chat, in person, etc.), never through Terraform or a committed file.

1. **Owner creates the user** by applying `terraform/console-users.tf` (see §5) with the new username added to the appropriate `tfvars` variable, then sets a **temporary password** by hand in the IAM console (IAM → Users → *user* → Security credentials → Console access → enable, set temporary password, check "user must reset at next sign-in"). No password ever passes through Terraform or state.
2. **Owner shares, out-of-band:**
   - the sign-in URL — read it with `terraform -chdir=terraform output signin_url` (don't hardcode the account id anywhere)
   - the username
   - the temporary password
3. **The user signs in** at that URL and is forced to set a new password immediately.
4. **The user enrolls an MFA device** (virtual/authenticator app) — this is **required**, not optional (§4). Until MFA is enrolled and present on the session, the user can do nothing in the console except view basic account info and manage their own password/MFA device.
5. Once MFA is enrolled, the user has full access to whatever their level grants (data view/edit, or full admin).

## 4. MFA enforcement

Both access levels carry the same "enforce MFA + self-service" policy (`console-enforce-mfa` in `terraform/console-users.tf`, the canonical AWS reference pattern):

- A user can always view basic account/password-policy info and manage **their own** password and MFA device (scoped to their own username — they cannot touch anyone else's).
- Everything else is explicitly **denied** unless the session is MFA-authenticated (`aws:MultiFactorAuthPresent` true). A plain password-only sign-in — including right after first login, before MFA is enrolled — cannot touch DynamoDB data or, for the admin, anything else in the account.
- For the DynamoDB data users, this policy is attached to their shared group (`soa-dynamodb-console`). For the administrator, it's attached directly to their user, since the pre-existing `Admins` group is left unmanaged (§5).

## 5. Administrator note

The administrator grant is a deliberate, trusted "same as the account owner" exception — not a least-privilege identity:

- The admin user is added to the account's existing `Admins` group, which carries `AdministratorAccess`. This means full control of the account: creating/deleting any resource, modifying or deleting IAM (including the deployer role, the permissions boundary, and these very console users), and billing.
- Terraform adds the admin to `Admins` **additively** (`aws_iam_user_group_membership`, which manages only that one user's group memberships) — it never manages the group's full member list, so applying this config can never remove the existing account owner from `Admins`.
- MFA is enforced on the admin's user directly (§4) — a leaked admin password alone still can't act.
- **Open gap:** the account owner's own IAM identity currently has no MFA enforced. Enrolling MFA on the owner (or enforcing it at the `Admins` group level) is a recommended follow-up so both full-admin identities are equally protected — see the PRD's [Additional considerations](../action_plan/platform/0007-dynamodb-console-users.md#9-additional-considerations).

## 6. How this is provisioned

- Defined in [`terraform/console-users.tf`](../../terraform/console-users.tf), part of the **human-applied identity foundation** (`terraform/` root) — see [terraform-foundation.md](terraform-foundation.md). `soa-deployer` cannot create IAM users, so a human with admin credentials runs `terraform apply` here, the same as the rest of the foundation.
- Real usernames never appear in a committed file: they're supplied via a gitignored tfvars file, following the pattern in the committed template [`terraform/console-users.tfvars.example`](../../terraform/console-users.tfvars.example).
- **Cost: $0.** IAM users, groups, and policies are free.
- **Not part of routine teardown.** Like the rest of the identity foundation, this config is not touched by `terraform destroy` on `terraform/app-edge/` between sessions — see [cost-lifecycle.md](cost-lifecycle.md).

## Related docs

- [terraform-foundation.md](terraform-foundation.md) — the identity foundation this config lives in
- [adding-a-service.md](adding-a-service.md) — how new `soa-*` tables actually get created
- [PRD platform/0007](../action_plan/platform/0007-dynamodb-console-users.md) — the approved plan behind this doc
