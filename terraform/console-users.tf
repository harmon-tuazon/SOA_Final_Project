# IAM console users (PRD platform/0007): two least-privilege DynamoDB data
# users, plus one full-administrator "trusted co-owner" user. Console-only —
# no access keys are issued to anyone here.
#
# HUMAN-APPLIED, same as the rest of this root config: soa-deployer cannot
# create IAM users (its iam:Create* grants are scoped to roles/policies, not
# users), so this file is applied by a human with admin credentials, never
# by the pipeline.
#
# Real usernames are supplied via a gitignored tfvars file (see
# console-users.tfvars.example) — never hardcoded here and never committed.

# --- Variables ---------------------------------------------------------------

variable "console_users" {
  description = "Usernames for the least-privilege DynamoDB console users (view/edit soa-* table data, no table lifecycle). Supplied via a gitignored tfvars file — never defaulted or committed."
  type        = list(string)
}

variable "admin_console_users" {
  description = "Usernames for full-administrator ('same as owner') console users, added to the existing admin_group_name group. Supplied via a gitignored tfvars file — never defaulted or committed."
  type        = list(string)
}

variable "admin_group_name" {
  description = "Name of the existing, unmanaged IAM group that carries AdministratorAccess (e.g. \"Admins\"). Not created or otherwise managed by this config — only referenced by name for aws_iam_user_group_membership."
  type        = string
  default     = "Admins"
}

# --- Shared ARN locals ---------------------------------------------------------

locals {
  # Every soa-* table, and its indexes, in this project's account/region.
  # Reused across the view/edit/deny statements below so the scope can't
  # drift between them.
  dynamodb_table_arn = "arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-*"
  dynamodb_index_arn = "${local.dynamodb_table_arn}/index/*"
}

# --- Least-privilege DynamoDB console users ----------------------------------

# No login profile: passwords are set manually in the console (IAM > Users >
# <user> > Security credentials), so no password material ever enters
# Terraform state.
resource "aws_iam_user" "dynamodb_console" {
  for_each = toset(var.console_users)
  name     = each.value
}

resource "aws_iam_group" "dynamodb_console" {
  name = "${var.name_prefix}-dynamodb-console"
}

# Per-user, additive: aws_iam_user_group_membership manages only the group
# list for THIS user, unlike aws_iam_group_membership (which would own the
# group's entire member list). Safe to use even though it's the only group
# these users belong to.
resource "aws_iam_user_group_membership" "dynamodb_console" {
  for_each = aws_iam_user.dynamodb_console

  user   = each.value.name
  groups = [aws_iam_group.dynamodb_console.name]
}

# Data policy: view + edit (incl. row delete) on soa-* table items, plus the
# account-level list/describe actions the console needs to render — with an
# explicit Deny on every table-lifecycle action. Deny always wins, so this
# remains the durable floor even if a future edit accidentally adds a
# broader grant.
data "aws_iam_policy_document" "dynamodb_console_data" {
  statement {
    sid    = "AllowViewItems"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PartiQLSelect",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:ListTagsOfResource",
    ]
    resources = [local.dynamodb_table_arn, local.dynamodb_index_arn]
  }

  statement {
    sid    = "AllowEditItems"
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLUpdate",
      "dynamodb:PartiQLDelete",
    ]
    resources = [local.dynamodb_table_arn, local.dynamodb_index_arn]
  }

  # Account-level actions the DynamoDB console needs to render the table
  # list/limits page. These cannot be resource-scoped in IAM, but they are
  # read-only metadata (table names, account limits) — actually opening or
  # editing a table's data still requires the soa-* scoped grants above.
  statement {
    sid    = "AllowConsoleListing"
    effect = "Allow"
    actions = [
      "dynamodb:ListTables",
      "dynamodb:DescribeLimits",
      "dynamodb:DescribeEndpoints",
    ]
    resources = ["*"]
  }

  # Explicit DENY: no table lifecycle, ever, for these users — creating,
  # restructuring, or deleting a soa-* table (or its backups/replicas/global
  # table config) stays exclusively with the pipeline/deployer role. Deny
  # always wins regardless of any Allow, so this holds even if a future edit
  # to this policy (or a different policy attached to this group) tries to
  # grant one of these actions.
  statement {
    sid    = "DenyTableLifecycle"
    effect = "Deny"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:DeleteTable",
      "dynamodb:UpdateTable",
      "dynamodb:CreateBackup",
      "dynamodb:DeleteBackup",
      "dynamodb:RestoreTableFromBackup",
      "dynamodb:RestoreTableToPointInTime",
      "dynamodb:CreateGlobalTable",
      "dynamodb:UpdateGlobalTable",
      "dynamodb:UpdateGlobalTableSettings",
      "dynamodb:ImportTable",
      "dynamodb:ExportTableToPointInTime",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:CreateTableReplica",
      "dynamodb:DeleteTableReplica",
    ]
    resources = [local.dynamodb_table_arn, local.dynamodb_index_arn]
  }
}

resource "aws_iam_policy" "dynamodb_console_data" {
  name        = "${var.name_prefix}-dynamodb-console-data"
  description = "View + edit (incl. row delete) access to soa-* DynamoDB table data for console users; explicit deny on all table-lifecycle actions."
  policy      = data.aws_iam_policy_document.dynamodb_console_data.json
}

resource "aws_iam_group_policy_attachment" "dynamodb_console_data" {
  group      = aws_iam_group.dynamodb_console.name
  policy_arn = aws_iam_policy.dynamodb_console_data.arn
}

# --- MFA enforcement (canonical AWS "enforce MFA + self-service" pattern) ---
#
# https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_enable_cli.html
# ("AllowManageOwnPasswordAndMFA" / IAM reference policy for enforcing MFA).
# Shared by the DynamoDB console group AND the admin user below, so both
# identities are held to the same "must enroll MFA before doing anything
# else" bar.
data "aws_iam_policy_document" "console_enforce_mfa" {
  statement {
    sid    = "AllowViewAccountInfo"
    effect = "Allow"
    actions = [
      "iam:GetAccountPasswordPolicy",
      "iam:GetAccountSummary",
      "iam:ListVirtualMFADevices",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowManageOwnPassword"
    effect = "Allow"
    actions = [
      "iam:ChangePassword",
      "iam:GetUser",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:user/$${aws:username}"]
  }

  statement {
    sid    = "AllowManageOwnMFA"
    effect = "Allow"
    actions = [
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:ResyncMFADevice",
      "iam:ListMFADevices",
      "iam:GetMFADevice",
      "iam:DeactivateMFADevice",
      "iam:DeleteVirtualMFADevice",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:user/$${aws:username}",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:mfa/$${aws:username}",
    ]
  }

  # Deny everything else unless the session is MFA-authenticated. BoolIfExists
  # treats a session with no aws:MultiFactorAuthPresent key (i.e. a plain
  # password sign-in before MFA is enrolled) the same as "false" — so a user
  # can do nothing but view account info / set their password / enroll MFA
  # until they've authenticated with MFA.
  statement {
    sid    = "DenyAllExceptListedIfNoMFA"
    effect = "Deny"
    not_actions = [
      "iam:GetAccountPasswordPolicy",
      "iam:GetAccountSummary",
      "iam:ListVirtualMFADevices",
      "iam:ChangePassword",
      "iam:GetUser",
      "iam:CreateVirtualMFADevice",
      "iam:EnableMFADevice",
      "iam:ResyncMFADevice",
      "iam:ListMFADevices",
      "iam:GetMFADevice",
      "iam:DeactivateMFADevice",
      "iam:DeleteVirtualMFADevice",
    ]
    resources = ["*"]

    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
}

resource "aws_iam_policy" "console_enforce_mfa" {
  name        = "${var.name_prefix}-console-enforce-mfa"
  description = "Canonical AWS 'enforce MFA + self-service' policy: lets a console user view account info and manage their own password/MFA device, denies everything else until they've authenticated with MFA."
  policy      = data.aws_iam_policy_document.console_enforce_mfa.json
}

resource "aws_iam_group_policy_attachment" "console_enforce_mfa" {
  group      = aws_iam_group.dynamodb_console.name
  policy_arn = aws_iam_policy.console_enforce_mfa.arn
}

# --- Administrator user (full AdministratorAccess, "same as owner") ---------
#
# SAFETY-CRITICAL: membership uses aws_iam_user_group_membership, which
# manages only THIS user's group list. It deliberately does NOT use
# aws_iam_group_membership, which would own the ENTIRE member list of
# admin_group_name and delete every other existing member (including the
# account owner) on apply. The admin_group_name group and its
# AdministratorAccess policy are pre-existing and unmanaged by this config.
resource "aws_iam_user" "admin_console" {
  for_each = toset(var.admin_console_users)
  name     = each.value
}

resource "aws_iam_user_group_membership" "admin_console" {
  for_each = aws_iam_user.admin_console

  user   = each.value.name
  groups = [var.admin_group_name]
}

# MFA is enforced directly on the admin's user (not via the group, since the
# admin_group_name group is unmanaged here) — a leaked admin password alone
# still can't act until MFA is enrolled and present on the session.
resource "aws_iam_user_policy_attachment" "admin_console_enforce_mfa" {
  for_each = aws_iam_user.admin_console

  user       = each.value.name
  policy_arn = aws_iam_policy.console_enforce_mfa.arn
}

# --- Output --------------------------------------------------------------

output "signin_url" {
  description = "Console sign-in URL to hand to each console user alongside their username/temporary password."
  value       = "https://${data.aws_caller_identity.current.account_id}.signin.aws.amazon.com/console"
}
