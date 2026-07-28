# Wires the app-edge config's modules together. This is a thin root: modules
# do the actual resource creation, this file just passes inputs between them.
#
# app-edge is the DESTROYABLE, billable half of the base/edge split (PRD
# platform/0006, superseding the single "terraform/app/" config from ADR
# 0002): the shared ALB + HTTP listener, and every service's ecs-service
# module (task role, target group, listener rule, task definition, ECS
# service, autoscaling). This is what `terraform destroy` targets between
# sessions — app-base (network/cluster/roles/tables) is untouched by that.
# Modules referenced here live in the shared ../modules/ directory (used by
# both app-base and app-edge).

# --- Cross-config wiring: read app-base's outputs ---------------------------
#
# app-base owns the VPC/subnets, the ECS cluster, the shared execution role,
# and the ALB security group — all free, permanent resources this config
# consumes but does not create. Same bucket/region as this config's own
# backend.tf, distinct key.
data "terraform_remote_state" "base" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "app-base/terraform.tfstate"
    region = var.region
  }
}

# Used to build the soa-boundary ARN, and each service's DynamoDB table
# ARN(s), as plain strings below (never via a data-source lookup — the
# soa-deployer role deliberately doesn't have iam:ListPolicies, and reading
# a table's ARN back from app-base's state would mean a remote_state read
# per service; the string pattern below matches the boundary ARN's existing
# approach and needs no such read). See terraform/iam.tf.
data "aws_caller_identity" "current" {}

locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-boundary"

  # app-base outputs this config needs to place the ALB and each service.
  vpc_id             = data.terraform_remote_state.base.outputs.vpc_id
  public_subnet_ids  = data.terraform_remote_state.base.outputs.public_subnet_ids
  cluster_id         = data.terraform_remote_state.base.outputs.cluster_id
  execution_role_arn = data.terraform_remote_state.base.outputs.execution_role_arn
  alb_sg_id          = data.terraform_remote_state.base.outputs.alb_sg_id

  # Cognito identifiers (PRD platform/0009) and the SPA's origin — all
  # non-secret. Read by the user service (PRD user/0001) for JWKS-based token
  # verification and CORS: the SPA sends an Authorization header on every
  # call, which makes every cross-origin request preflighted, so
  # CORS_ALLOWED_ORIGIN must be correct for the app to work at all.
  cognito_user_pool_id = data.terraform_remote_state.base.outputs.cognito_user_pool_id
  cognito_client_id    = data.terraform_remote_state.base.outputs.cognito_client_id
  frontend_origin      = "http://${data.terraform_remote_state.base.outputs.frontend_website_endpoint}"

  # Ops-alerts SNS topic (PRD platform/0011), owned by app-base's
  # observability module. Used as the alarm_actions target for the shared
  # ALB's 5xx alarm and each service's CPU-high alarm. try(...) so this config
  # still plans before app-base has applied the new output (e.g. this PR's CI
  # edge-plan): empty -> the count-guarded alarms create nothing, and the real
  # ARN resolves once CD applies app-base first, then this config, on merge.
  alerts_topic_arn = try(data.terraform_remote_state.base.outputs.alerts_topic_arn, "")

  # The async branch's notifications queue (PRD platform/0008) — the producer
  # needs the URL as env (to call sqs:SendMessage) and the ARN to scope its
  # task role's SendMessage permission to this queue only.
  notifications_queue_url = data.terraform_remote_state.base.outputs.notifications_queue_url
  notifications_queue_arn = data.terraform_remote_state.base.outputs.notifications_queue_arn
}

# --- Shared edge: ALB + HTTP listener (the only billable resource this
#     config creates directly; gone on `terraform destroy`) -----------------

module "alb" {
  source = "../modules/alb"

  name_prefix       = var.name_prefix
  public_subnet_ids = local.public_subnet_ids
  alb_sg_id         = local.alb_sg_id
  alerts_topic_arn  = local.alerts_topic_arn
}

# --- Services ----------------------------------------------------------------
#
# Each service adds an `ecs-service` module block below — its matching
# `data` (table) module block goes in terraform/app-base/main.tf instead.
# Use `/new-service` to scaffold both halves of a service in one PR.
#
# A service's table ARN is constructed as a STRING (never a remote_state
# read against app-base's per-table outputs) — same pattern already used for
# boundary_arn above, via data.aws_caller_identity. The `data` module in
# app-base is what actually CREATES the table; this string just scopes the
# task role to it:
#
# module "example_service" {
#   source = "../modules/ecs-service"
#
#   name_prefix         = var.name_prefix
#   region              = var.region
#   name                = "example"
#   port                = 3000
#   image_tag           = var.image_tag
#   route               = "/example*"
#   priority            = 100
#   env                 = { EXAMPLE_TABLE = "${var.name_prefix}-example" }
#   table_arns          = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-example"]
#   vpc_id              = local.vpc_id
#   public_subnet_ids   = local.public_subnet_ids
#   cluster_id          = local.cluster_id
#   alb_sg_id           = local.alb_sg_id
#   listener_arn        = module.alb.listener_arn
#   execution_role_arn  = local.execution_role_arn
#   boundary_arn        = local.boundary_arn
#   alerts_topic_arn    = local.alerts_topic_arn
# }

# order service (PRD order/0001) — the first service on the shared listener,
# so it takes priority 100; the next service takes 110. Its table is created
# by module.order_table in app-base and referenced here only as a
# constructed ARN string, since this config cannot see app-base's modules.
module "order_service" {
  source = "../modules/ecs-service"

  name_prefix        = var.name_prefix
  region             = var.region
  name               = "order"
  port               = 3000
  image_tag          = var.image_tag
  route              = "/orders*"
  priority           = 100
  env                = { ORDER_TABLE = "${var.name_prefix}-order" }
  table_arns         = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-order"]
  vpc_id             = local.vpc_id
  public_subnet_ids  = local.public_subnet_ids
  cluster_id         = local.cluster_id
  alb_sg_id          = local.alb_sg_id
  listener_arn       = module.alb.listener_arn
  execution_role_arn = local.execution_role_arn
  boundary_arn       = local.boundary_arn
  alerts_topic_arn   = local.alerts_topic_arn
}

# product service (PRD product/0001) — the second service on the shared
# listener, so it takes priority 110 (order holds 100; the next service
# takes 120). Its table is created by module.product_table in app-base and
# referenced here only as a constructed ARN string, since this config cannot
# see app-base's modules.
module "product_service" {
  source = "../modules/ecs-service"

  name_prefix        = var.name_prefix
  region             = var.region
  name               = "product"
  port               = 3000
  image_tag          = var.image_tag
  route              = "/products*"
  priority           = 110
  env                = { PRODUCT_TABLE = "${var.name_prefix}-product" }
  table_arns         = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-product"]
  vpc_id             = local.vpc_id
  public_subnet_ids  = local.public_subnet_ids
  cluster_id         = local.cluster_id
  alb_sg_id          = local.alb_sg_id
  listener_arn       = module.alb.listener_arn
  execution_role_arn = local.execution_role_arn
  boundary_arn       = local.boundary_arn
  alerts_topic_arn   = local.alerts_topic_arn
}

# user service (PRD user/0001); priority 120 (order holds 100, product holds
# 110; the next service takes 130). No task-role change for Cognito is needed — JWKS
# verification is an unauthenticated HTTPS fetch of public keys, not an AWS
# API call, so the boundary's cognito-idp:* allowances go unused by design.
module "user_service" {
  source = "../modules/ecs-service"

  name_prefix = var.name_prefix
  region      = var.region
  name        = "user"
  port        = 3000
  image_tag   = var.image_tag
  route       = "/users*"
  priority    = 120

  env = {
    USER_TABLE              = "${var.name_prefix}-user"
    COGNITO_USER_POOL_ID    = local.cognito_user_pool_id
    COGNITO_CLIENT_ID       = local.cognito_client_id
    CORS_ALLOWED_ORIGIN     = local.frontend_origin
    NOTIFICATIONS_QUEUE_URL = local.notifications_queue_url
  }

  table_arns = ["arn:aws:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-user"]
  # First producer on the async branch (PRD platform/0008) — fire-and-forget
  # publish on first profile creation; scoped to this queue only.
  sqs_send_arns      = [local.notifications_queue_arn]
  vpc_id             = local.vpc_id
  public_subnet_ids  = local.public_subnet_ids
  cluster_id         = local.cluster_id
  alb_sg_id          = local.alb_sg_id
  listener_arn       = module.alb.listener_arn
  execution_role_arn = local.execution_role_arn
  boundary_arn       = local.boundary_arn
  alerts_topic_arn   = local.alerts_topic_arn
}
