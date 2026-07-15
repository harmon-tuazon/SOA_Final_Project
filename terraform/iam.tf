# GitHub OIDC provider + deployer role.
#
# This gives GitHub Actions a way to authenticate to AWS without any
# long-lived access keys: GitHub issues a short-lived OIDC token for each
# workflow run, AWS trusts tokens from this provider, and the workflow
# assumes the "soa-deployer" role for the duration of the run.
#
# Kept inline in the root config (rather than a modules/iam module) since
# this is a single, root-level identity concern with no per-service inputs
# to parameterize yet. If task/execution roles grow into their own
# per-service module later, this file is the natural place to split from.
#
# This file is HUMAN-APPLIED (`terraform -chdir=terraform apply` with admin
# credentials) — soa-deployer cannot modify its own IAM (see the self-edit
# denies below), so identity-foundation changes, including the self-serve
# table grant/deny added by PRD platform/0006, always need a local apply by
# a human. The pipeline (cd.yml) never touches this config.

# --- Account identity --------------------------------------------------------
#
# Used to scope every self-referencing IAM ARN below (role/policy/OIDC
# provider ARNs, and the deny statement guarding the permissions boundary)
# to this account specifically, instead of a cross-account "*" wildcard.
data "aws_caller_identity" "current" {}

# --- GitHub OIDC identity provider -----------------------------------------

# AWS validates the provider's TLS certificate chain rather than the
# thumbprint for well-known providers like GitHub, but the resource still
# requires a thumbprint_list. Deriving it from the live certificate (instead
# of hardcoding a value that can go stale) is the AWS-provider-recommended
# pattern.
data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]
}

# --- Deployer role -----------------------------------------------------------

# Trust policy: only workflow runs from this repo's `main` branch may assume
# this role. Any other branch, fork, or PR run is rejected.
data "aws_iam_policy_document" "deployer_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deployer" {
  name               = "${var.name_prefix}-deployer"
  description        = "Assumed by GitHub Actions (OIDC) on the main branch to plan/apply Terraform and deploy this project."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
}

# --- Workload permissions boundary -------------------------------------------
#
# This is the effective-permission CEILING for every workload role the
# deployer creates (ECS task roles, ECS task execution roles, Lambda
# execution roles) — not a grant on its own. A role with this boundary
# attached can never do more than what's allowed here, no matter what
# policies get attached to it later. It only ever narrows a role's actual
# permissions, so `Resource = "*"` inside the boundary is safe: real access
# still has to come from an identity policy on top of it.
#
# It is intentionally narrow (only the data-plane actions this project's
# workloads need per ADR 0001) and carries no iam:*, sts:AssumeRole*,
# organizations:*, or account:* actions — a role bound by this policy cannot
# create/modify roles or policies, so it cannot re-escalate itself.
#
# This boundary is tightened or extended per workload PRD as real services
# land (e.g. adding a specific queue ARN once it exists). Widening it is
# itself a privileged, security-relevant change and should be reviewed as
# such, not done casually.
data "aws_iam_policy_document" "boundary" {
  statement {
    sid    = "DynamoDbDataAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DescribeTable",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SqsDataAccess"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "SnsPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = ["*"]
  }

  statement {
    sid    = "S3ObjectAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SsmParameterRead"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "LogsWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "CloudWatchMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPull"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "CognitoAppAuth"
    effect = "Allow"
    actions = [
      "cognito-idp:AdminInitiateAuth",
      "cognito-idp:GetUser",
      "cognito-idp:ListUsers",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "XrayTracing"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = "${var.name_prefix}-boundary"
  description = "Effective-permission ceiling for every workload role (ECS task roles, ECS task execution roles, Lambda execution roles) in this project. Attached as a PermissionsBoundary, not a grant on its own."
  policy      = data.aws_iam_policy_document.boundary.json
}

# --- Deployer permissions policy --------------------------------------------
#
# Scoped to exactly the AWS services this project's architecture (ADR 0001)
# uses. No AdministratorAccess/PowerUserAccess, and no single
# "Action":"*"/"Resource":"*" statement anywhere below.

data "aws_iam_policy_document" "deployer_permissions" {

  # Terraform remote state: read/write objects in the state bucket, scoped to
  # exactly the two keys this role applies — "app-base/" and "app-edge/"
  # (PRD platform/0006 infra-review tightening). s3:ListBucket keeps the
  # bucket-level ARN (that action authorizes against the bucket itself, not
  # an object key, so it can't be key-prefix-scoped further; it's still
  # needed for the S3 backend to check for/lock state). The object-level ARN
  # is narrowed from a bucket-wide "*/*" wildcard to just these two
  # prefixes, each covering both a config's "terraform.tfstate" and its
  # native S3-lock object (use_lockfile writes a lock object alongside the
  # state under the same key prefix) — so GetObject/PutObject/DeleteObject
  # for both state and locking still work. "app-edge/"'s read of
  # "app-base/terraform.tfstate" via terraform_remote_state is plain
  # s3:GetObject, already covered by the "app-base/*" entry — no separate
  # grant needed.
  #
  # Deliberately EXCLUDES "platform/*" — the identity foundation's own state
  # (this root config, human-applied). The deployer is assumable by any push
  # to main, so it must never be able to read, overwrite, or delete that
  # state, even though the object-level actions were previously
  # indistinguishable from app-base/app-edge access under one bucket-wide
  # wildcard.
  statement {
    sid    = "TerraformStateAccess"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::${var.name_prefix}-tfstate-*",
      "arn:aws:s3:::${var.name_prefix}-tfstate-*/app-base/*",
      "arn:aws:s3:::${var.name_prefix}-tfstate-*/app-edge/*",
    ]
  }

  # ECS: cluster, services, task definitions for the Fargate workloads.
  statement {
    sid       = "EcsManagement"
    effect    = "Allow"
    actions   = ["ecs:*"]
    resources = ["*"]
  }

  # ECR: image repositories for the containerized services.
  statement {
    sid       = "EcrManagement"
    effect    = "Allow"
    actions   = ["ecr:*"]
    resources = ["*"]
  }

  # EC2 read-only discovery (VPCs, subnets, route tables, security groups,
  # AMIs, availability zones, etc.). Describe* actions do not support
  # resource-level restriction in IAM, so Resource "*" is required here —
  # this is a read-only statement, not account-wide write access.
  # ec2:GetSecurityGroupsForVpc is a newer read action the ELBv2
  # CreateLoadBalancer flow requires; it is NOT matched by ec2:Describe*.
  statement {
    sid    = "Ec2ReadOnly"
    effect = "Allow"
    actions = [
      "ec2:Describe*",
      "ec2:GetSecurityGroupsForVpc",
    ]
    resources = ["*"]
  }

  # EC2 network management: create/modify/delete the VPC, subnets, route
  # tables, internet gateway, and security groups this project needs.
  # Most of these EC2 actions do not support resource-level ARN scoping in
  # IAM (the resource doesn't exist yet at authorization time, or AWS simply
  # doesn't define fine-grained resource types for it), so Resource "*" is
  # the practical option — the statement is still scoped to specific,
  # named actions rather than "ec2:*".
  statement {
    sid    = "Ec2NetworkManagement"
    effect = "Allow"
    actions = [
      "ec2:CreateVpc",
      "ec2:DeleteVpc",
      "ec2:ModifyVpcAttribute",
      "ec2:CreateSubnet",
      "ec2:DeleteSubnet",
      "ec2:ModifySubnetAttribute",
      "ec2:CreateRouteTable",
      "ec2:DeleteRouteTable",
      "ec2:CreateRoute",
      "ec2:DeleteRoute",
      "ec2:AssociateRouteTable",
      "ec2:DisassociateRouteTable",
      "ec2:CreateInternetGateway",
      "ec2:DeleteInternetGateway",
      "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:CreateTags",
      "ec2:DeleteTags",
    ]
    resources = ["*"]
  }

  # Elastic Load Balancing: the single shared ALB in front of ECS services.
  statement {
    sid       = "ElbManagement"
    effect    = "Allow"
    actions   = ["elasticloadbalancing:*"]
    resources = ["*"]
  }

  # S3 frontend bucket: scoped BUCKET-level management for the SPA static
  # website (PRD frontend/0001, human-applied). The bucket lives in
  # pipeline-applied app-base, so soa-deployer needs create/manage powers on
  # it — scoped by name prefix to "soa-frontend-*" only, distinct from and
  # never overlapping with the Terraform state bucket ("soa-tfstate-*",
  # covered separately by TerraformStateAccess above). Enumerates the
  # bucket-attribute reads Terraform's aws_s3_bucket/_website_configuration/
  # _public_access_block/_policy/_ownership_controls resources perform on
  # every refresh, plus the writes those resources need to apply — so a
  # plan/apply never hits AccessDenied on an attribute Terraform silently
  # reads. Deliberately excludes s3:DeleteBucket (see the explicit Deny
  # below) — the deployer manages this bucket's contents/config but must
  # never delete the bucket itself, mirroring the DynamoDB DeleteTable
  # pattern.
  statement {
    sid    = "FrontendBucketManagement"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:PutBucketPolicy",
      "s3:GetBucketPolicy",
      "s3:GetBucketPolicyStatus",
      "s3:PutBucketWebsite",
      "s3:GetBucketWebsite",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "s3:GetBucketOwnershipControls",
      "s3:PutBucketTagging",
      "s3:GetBucketTagging",
      "s3:GetBucketAcl",
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
      "s3:GetBucketCORS",
      "s3:GetEncryptionConfiguration",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketLogging",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketNotification",
      "s3:ListBucket",
    ]
    resources = ["arn:aws:s3:::${var.name_prefix}-frontend-*"]
  }

  # S3 frontend bucket: object read/write/delete for the SPA build output
  # and the backend-owned config.json — frontend-cd.yml (build sync) and
  # backend cd.yml (config.json refresh) both act as soa-deployer.
  # DeleteObject is required so `aws s3 sync --delete` can prune assets from
  # a previous deploy.
  statement {
    sid    = "FrontendObjectAccess"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::${var.name_prefix}-frontend-*/*"]
  }

  # DynamoDB: scoped table CONTROL-PLANE management for self-serve tables
  # (PRD platform/0006, "Option 2" — tightened after infra-review). This is
  # now the PRIMARY and ONLY DynamoDB grant on this role: the previous
  # broad "dynamodb:*" on "*" statement has been removed entirely, because
  # it still allowed data-plane deletes (DeleteItem, BatchWriteItem,
  # PartiQL deletes, etc.) on every table — the DeleteTable Deny below only
  # ever protected the table OBJECT, not the data inside it. Exactly the
  # actions Terraform's aws_dynamodb_table resource needs to create/read/
  # update a table and keep its state refreshed — no data-plane actions
  # (Get/Put/Query/Scan/...; those belong solely to each service's task
  # role, scoped by the boundary), no DeleteTable/DeleteBackup (the explicit
  # Deny below is a backstop against a future statement re-adding one, not
  # the sole protection anymore). ListTagsOfResource is required for
  # Terraform to refresh a table's tags on plan/apply once the broad grant
  # is gone — without it, refresh breaks on any tag drift. Scoped to soa-*
  # tables in this project's region only, never account-wide.
  statement {
    sid    = "DynamoDbTableLifecycleManagement"
    effect = "Allow"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:DescribeTable",
      "dynamodb:UpdateTable",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:UpdateContinuousBackups",
    ]
    resources = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-*"]
  }

  # SQS: the async work queue between ECS and Lambda.
  statement {
    sid       = "SqsManagement"
    effect    = "Allow"
    actions   = ["sqs:*"]
    resources = ["*"]
  }

  # SNS: notification fan-out from the Lambda worker.
  statement {
    sid       = "SnsManagement"
    effect    = "Allow"
    actions   = ["sns:*"]
    resources = ["*"]
  }

  # CloudWatch Logs: ECS/Lambda log groups and streams.
  statement {
    sid       = "LogsManagement"
    effect    = "Allow"
    actions   = ["logs:*"]
    resources = ["*"]
  }

  # Application Auto Scaling: ECS service scaling policies.
  statement {
    sid       = "AutoScalingManagement"
    effect    = "Allow"
    actions   = ["application-autoscaling:*"]
    resources = ["*"]
  }

  # CloudWatch: alarms/dashboards for observability and the cost budget.
  statement {
    sid       = "CloudWatchManagement"
    effect    = "Allow"
    actions   = ["cloudwatch:*"]
    resources = ["*"]
  }

  # Cognito: the user pool used for application auth.
  statement {
    sid       = "CognitoManagement"
    effect    = "Allow"
    actions   = ["cognito-idp:*"]
    resources = ["*"]
  }

  # IAM: the GitHub OIDC provider itself (this single resource, created by
  # this same root config).
  statement {
    sid    = "IamOidcProviderManagement"
    effect = "Allow"
    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"]
  }

  # IAM: create project roles (ECS task roles, task execution roles, Lambda
  # execution roles, and this deployer role itself), but ONLY with the
  # workload permissions boundary attached. This is the permissions-boundary
  # pattern's core control: it stops the deployer from minting a soa-* role
  # with no ceiling, attaching an admin-equivalent policy, and PassRole'ing
  # it into a task — the boundary caps the role's effective permissions
  # regardless of what identity policy later gets attached to it.
  #
  # Split into its own statement (rather than folded into the general role
  # statement below) because a condition on a single statement applies to
  # every action in it, and iam:PermissionsBoundary is only meaningful for
  # CreateRole/PutRolePermissionsBoundary — bundling it with GetRole/TagRole/
  # PassRole would incorrectly require a boundary condition value on actions
  # that don't take one.
  statement {
    sid       = "IamProjectRoleCreate"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }

  # IAM: lifecycle + READ actions on project roles only (never account-wide).
  # Includes the read actions Terraform needs to REFRESH a role on every plan/
  # apply — GetRole, ListRolePolicies, GetRolePolicy, ListAttachedRolePolicies,
  # ListRoleTags. These are read-only and cannot escalate (they only inspect a
  # role). Deliberately STILL excludes the inline-policy WRITES
  # (PutRolePolicy/DeleteRolePolicy) — inline writes were the escalation vector,
  # and this design uses only customer-managed policies. Also excludes
  # AttachRolePolicy/DetachRolePolicy (own conditioned statement below) and
  # PutRolePermissionsBoundary/DeleteRolePermissionsBoundary entirely — the
  # deployer must never strip or swap a role's boundary once iam:CreateRole set it.
  statement {
    sid    = "IamProjectRoleManagement"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:ListAttachedRolePolicies",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PassRole",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*"]
  }

  # IAM: attach/detach policies on project roles, but only customer-managed
  # soa-* policies — this is what stops the deployer from attaching an
  # AWS-managed policy like AdministratorAccess (whose ARN never matches
  # policy/soa-*) to a role it controls.
  statement {
    sid    = "IamProjectRolePolicyAttachment"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*"]

    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::*:policy/${var.name_prefix}-*"]
    }
  }

  # IAM: customer-managed policies for this project only (attached to the
  # roles above), never account-wide.
  statement {
    sid    = "IamProjectPolicyManagement"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-*"]
  }

  # IAM service-linked roles: AWS auto-creates these the first time an account
  # uses ECS, ELB, or ECS Service Auto Scaling. They are AWS-managed roles under
  # /aws-service-role/ (not soa-*), so this is a separate grant, condition-scoped
  # to exactly those three service principals — it cannot mint arbitrary roles.
  statement {
    sid       = "CreateServiceLinkedRoles"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "ecs.amazonaws.com",
        "ecs.application-autoscaling.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
      ]
    }
  }

  # Explicit DENY: BACKSTOP for the data-safety guarantee on self-serve
  # tables (PRD platform/0006, "Option 2" — tightened after infra-review).
  # The primary protection is now that DynamoDbTableLifecycleManagement above
  # simply never grants DeleteTable/DeleteBackup (and the old account-wide
  # "dynamodb:*" statement is gone entirely) — soa-deployer has no DynamoDB
  # delete permission of any kind on soa-* tables to begin with. This Deny is
  # defense in depth on top of that: IAM deny always wins regardless of any
  # Allow and regardless of statement order, so even if a future edit
  # accidentally re-adds a broad "dynamodb:*"-style grant, table (and
  # backup) deletion still fails closed with AccessDenied instead of
  # silently wiping data. Intentional table deletion is a deliberate, human
  # `terraform apply` with admin credentials against terraform/app-base/ —
  # never something the pipeline can do.
  statement {
    sid    = "DenyDynamoDbTableDeletion"
    effect = "Deny"
    actions = [
      "dynamodb:DeleteTable",
      "dynamodb:DeleteBackup",
    ]
    resources = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-*"]
  }

  # Explicit DENY: BACKSTOP mirroring DenyDynamoDbTableDeletion above, for
  # the frontend bucket (PRD frontend/0001). FrontendBucketManagement above
  # never grants s3:DeleteBucket in the first place — this Deny is defense
  # in depth so a future edit can't accidentally re-add it. The bucket is a
  # permanent app-base resource (holds the SPA + config.json); intentional
  # deletion is a deliberate human action outside the pipeline's reach, not
  # something soa-deployer can do.
  statement {
    sid       = "DenyFrontendBucketDeletion"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket"]
    resources = ["arn:aws:s3:::${var.name_prefix}-frontend-*"]
  }

  # Explicit DENY, evaluated ahead of every Allow above (IAM deny always
  # wins). Two halves, because these actions authorize against different
  # resource types:
  #
  # (a) Edits to the boundary policy itself authorize against the POLICY ARN.
  #     The deployer can create/manage other soa-* policies via
  #     IamProjectPolicyManagement, but must never version, delete, or
  #     re-default the boundary policy — otherwise it could just widen the
  #     ceiling it is bound by.
  statement {
    sid    = "DenyBoundaryPolicyEdits"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = [aws_iam_policy.boundary.arn]
  }

  # (b) Attaching/stripping a permissions boundary authorizes against the
  #     ROLE ARN. These actions are never Allowed above; this deny is a
  #     belt-and-suspenders guarantee they can never be granted by a future
  #     edit — so a soa-* role can never have its boundary swapped or removed.
  statement {
    sid    = "DenyBoundaryRemoval"
    effect = "Deny"
    actions = [
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*"]
  }

  # Explicit DENY: the deployer must never escalate ITS OWN privileges.
  # Its own role (soa-deployer) and policy (soa-deployer-permissions) match
  # the soa-* globs that grant it IAM authority over project resources, so
  # without these two denies it could rewrite its own permissions policy,
  # attach an admin policy to itself, or rewrite its own trust to drop the
  # main-branch restriction. Deny beats Allow, closing that self-escalation.
  # The deployer's own role/policy are changed only by a human `terraform
  # apply` with admin credentials — never by the pipeline assuming this role.
  # ARNs are built literally (not via aws_iam_policy.deployer.arn) to avoid a
  # dependency cycle: this document is what builds that policy.

  # (a) Its own permissions policy — authorizes against the POLICY ARN.
  statement {
    sid    = "DenyDeployerPolicySelfEdit"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-deployer-permissions"]
  }

  # (b) Its own role — no self-attaching powers, rewriting its own trust, or
  #     passing itself to a service. Authorizes against the ROLE ARN.
  #     (Boundary add/remove on any soa-* role, including this one, is already
  #     denied by DenyBoundaryRemoval above.)
  statement {
    sid    = "DenyDeployerRoleSelfEdit"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:UpdateAssumeRolePolicy",
      "iam:PassRole",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-deployer"]
  }
}

resource "aws_iam_policy" "deployer" {
  name        = "${var.name_prefix}-deployer-permissions"
  description = "Least-privilege permissions for the ${var.name_prefix}-deployer role: only the AWS services this project's architecture uses, scoped where the service supports it."
  policy      = data.aws_iam_policy_document.deployer_permissions.json
}

resource "aws_iam_role_policy_attachment" "deployer" {
  role       = aws_iam_role.deployer.name
  policy_arn = aws_iam_policy.deployer.arn
}

# --- CI plan role --------------------------------------------------------
#
# Read-only counterpart to the deployer role, assumed by GitHub Actions on
# pull-request runs to authenticate `terraform fmt`/`validate`/`plan`
# (PRD platform/0002). Reuses the same OIDC provider above — no second
# provider is created. Trust is scoped to `pull_request` events on this repo
# only, so it can never be assumed from a `main`-branch push (that's the
# deployer's job) or from another repo/fork.
data "aws_iam_policy_document" "ci_plan_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:pull_request"]
    }
  }
}

resource "aws_iam_role" "ci_plan" {
  name               = "${var.name_prefix}-ci-plan"
  description        = "Assumed by GitHub Actions (OIDC) on pull-request runs to run terraform fmt/validate/plan read-only. Never assumable from main-branch pushes."
  assume_role_policy = data.aws_iam_policy_document.ci_plan_trust.json
}

# AWS-managed ReadOnlyAccess is the pragmatic default for a `terraform plan`
# role: plan needs to read across whatever services the config references,
# and that set grows as the project grows, so a hand-maintained scoped read
# policy would need updating every time a module adds a new resource type.
# This role can never write/create/delete (no CI identity gets a permissions
# boundary or write policy here) — infra-reviewer may replace this with a
# scoped read-only policy later if that's preferred over the managed policy.
resource "aws_iam_role_policy_attachment" "ci_plan" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# No permissions boundary here: the boundary above is the ceiling for
# WORKLOAD roles the deployer creates (ECS task roles, Lambda execution
# roles) via its scoped iam:CreateRole grant. soa-ci-plan is a CI identity
# created by a human `terraform apply`, not by the deployer, and is already
# constrained to read-only by ReadOnlyAccess — a boundary would be redundant
# ceiling on top of a role that already can't write anything.

# --- CI plan data-read deny (infra-reviewer finding #2) --------------------
#
# ReadOnlyAccess is broad: alongside the config/metadata reads `terraform
# plan` actually needs (dynamodb:Describe*, s3:ListBucket, etc.), it also
# grants reads of application DATA CONTENT — DynamoDB item reads and S3
# object contents — that `plan` never performs. `soa-ci-plan` is assumable
# from any pull-request run against this repo, so narrowing what a PR run
# can read is worth doing even though PRs here are same-repo only (see PRD
# platform/0002 §9 open risk).
#
# This explicit Deny is layered on top of the ReadOnlyAccess Allow above —
# IAM deny always wins regardless of evaluation order — and removes exactly
# two things `plan` doesn't use:
#   - DynamoDB item-level reads (Get/BatchGet/Query/Scan/PartiQL). `plan`
#     only calls dynamodb:DescribeTable (config), never reads items.
#   - S3 object contents (s3:GetObject) for every bucket EXCEPT the
#     Terraform state bucket, which is exempted via `not_resources` so
#     `plan` can still read remote state through the S3 backend.
data "aws_iam_policy_document" "ci_plan_data_read_deny" {
  statement {
    sid    = "DenyDynamoDbItemReads"
    effect = "Deny"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PartiQLSelect",
    ]
    resources = ["*"]
  }

  statement {
    sid           = "DenyS3ObjectReadsExceptState"
    effect        = "Deny"
    actions       = ["s3:GetObject"]
    not_resources = ["arn:aws:s3:::${var.name_prefix}-tfstate-*/*"]
  }
}

resource "aws_iam_policy" "ci_plan_data_read_deny" {
  name        = "${var.name_prefix}-ci-plan-data-read-deny"
  description = "Denies soa-ci-plan the application data-content reads (DynamoDB items, S3 object bodies) included in ReadOnlyAccess but never used by terraform plan, exempting the Terraform state bucket so plan still works."
  policy      = data.aws_iam_policy_document.ci_plan_data_read_deny.json
}

resource "aws_iam_role_policy_attachment" "ci_plan_data_read_deny" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = aws_iam_policy.ci_plan_data_read_deny.arn
}
