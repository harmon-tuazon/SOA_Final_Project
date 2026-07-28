# Wires the app-base config's modules together. This is a thin root: modules
# do the actual resource creation, this file just passes inputs between them.
#
# app-base is the PERMANENT, free half of the base/edge split (PRD
# platform/0006, superseding the single "terraform/app/" config from ADR
# 0002): network, the ECS cluster + shared execution role + ALB security
# group, and every service's DynamoDB table. It is pipeline-applied (so
# tables are self-serve — a new service's PR creates its own table with no
# human step) but is NEVER part of the routine `terraform destroy` cycle —
# that targets terraform/app-edge/ only. Modules referenced here live in the
# shared ../modules/ directory (used by both app-base and app-edge).

# The set of Availability Zones currently available to this account/region,
# used to spread the public subnets across zones without hardcoding names.
data "aws_availability_zones" "available" {
  state = "available"
}

# Used to build the soa-boundary ARN as a plain string below (never via an
# aws_iam_policy data-source lookup — that would need iam:ListPolicies,
# which the soa-deployer role deliberately doesn't have; see terraform/iam.tf
# and CLAUDE.md's IAM constraints).
data "aws_caller_identity" "current" {}

# ARN of the workload permissions boundary created once, by hand, in the
# root identity config (terraform/iam.tf). Every soa-* role this config
# creates (the ECS task execution role) MUST set this as its
# permissions_boundary, or the deployer's scoped iam:CreateRole (conditioned
# on this exact boundary) fails with AccessDenied.
locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-boundary"
}

module "network" {
  source = "../modules/network"

  name_prefix         = var.name_prefix
  vpc_cidr            = var.vpc_cidr
  public_subnet_cidrs = var.public_subnet_cidrs
  azs                 = slice(data.aws_availability_zones.available.names, 0, length(var.public_subnet_cidrs))
}

# --- Shared compute: ECS cluster + execution role + ALB SG (created once,
#     ALB itself lives in app-edge — see modules/alb) -----------------------

module "cluster" {
  source = "../modules/ecs-cluster"

  name_prefix  = var.name_prefix
  vpc_id       = module.network.vpc_id
  boundary_arn = local.boundary_arn
}

# --- Frontend hosting: S3 static website for the React SPA (PRD
#     frontend/0001) -------------------------------------------------------
#
# Permanent, always-on, ~$0 (a few MB of static assets within the S3 free
# tier). Lives in app-base (not app-edge) so the SPA survives the routine
# `terraform destroy` of edge/compute between sessions.

module "frontend" {
  source = "../modules/frontend"

  name_prefix = var.name_prefix
  account_id  = data.aws_caller_identity.current.account_id
}

# Application identity provider (PRD platform/0009). Permanent and free:
# user accounts must survive every app-edge teardown, and the pool costs
# nothing below 50k MAU.
module "cognito" {
  source = "../modules/cognito"

  name_prefix = var.name_prefix
}

# --- Service tables ----------------------------------------------------------
#
# Each service adds a `data` module block (its own DynamoDB table) below —
# its matching `ecs-service` module block goes in terraform/app-edge/main.tf
# instead. Use `/new-service` to scaffold both halves of a service in one PR.
#
# module "example_table" {
#   source = "../modules/data"
#
#   name_prefix = var.name_prefix
#   name        = "example"
#   hash_key    = "id"
# }

# order service (PRD order/0001). Permanent: orders survive every app-edge
# teardown, and the pipeline is denied DeleteTable, so no CD run can drop
# this table or its rows.
module "order_table" {
  source = "../modules/data"

  name_prefix = var.name_prefix
  name        = "order"
  hash_key    = "id"
}

# product service (PRD product/0001). Permanent: the catalog survives every
# app-edge teardown, and the pipeline is denied DeleteTable, so no CD run can
# drop this table or its rows.
module "product_table" {
  source = "../modules/data"

  name_prefix = var.name_prefix
  name        = "product"
  hash_key    = "id"
}

# user service (PRD user/0001). Permanent: profile + billing data survives
# every app-edge teardown, and the pipeline is denied DeleteTable. The hash
# key is the Cognito `sub` — Cognito owns identity, this table owns profile.
module "user_table" {
  source = "../modules/data"

  name_prefix = var.name_prefix
  name        = "user"
  hash_key    = "userId"
}

# --- Async branch: SQS -> Lambda -> SNS (PRD platform/0008) ------------------
#
# The event-driven half of the hybrid architecture (ADR 0001). Deliberately
# lives here in app-base, not app-edge: it is entirely free-tier and
# event-driven (no idle cost either way), so there is no reason for it to
# churn with the billable edge, and it must survive an `app-edge` teardown so
# the queue/topic/subscription stay intact between sessions.

module "notifications" {
  source = "../modules/messaging"

  name_prefix        = var.name_prefix
  name               = "notifications"
  notification_email = var.notification_email
}

module "notification_worker" {
  source = "../modules/lambda"

  name_prefix       = var.name_prefix
  name              = "notification-worker"
  source_file       = "${path.module}/../../functions/notification-worker/index.js"
  source_queue_arn  = module.notifications.queue_arn
  publish_topic_arn = module.notifications.topic_arn
  boundary_arn      = local.boundary_arn
}

# --- Monitoring: ops-alerts topic + cost budget + Lambda errors alarm
#     (PRD platform/0011) -----------------------------------------------------
#
# Free-tier: first 10 CloudWatch alarms and first 2 AWS Budgets per account
# are free; SNS email delivery is negligible. Lives in app-base (not
# app-edge) so the alerts topic and budget survive every app-edge teardown —
# app-edge's ALB/ecs-service alarms read the topic ARN back via
# terraform_remote_state rather than creating their own topic.
module "observability" {
  source = "../modules/observability"

  name_prefix          = var.name_prefix
  notification_email   = var.notification_email
  budget_limit_amount  = var.budget_limit_amount
  lambda_function_name = module.notification_worker.function_name
}
