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
}

# --- Shared edge: ALB + HTTP listener (the only billable resource this
#     config creates directly; gone on `terraform destroy`) -----------------

module "alb" {
  source = "../modules/alb"

  name_prefix       = var.name_prefix
  public_subnet_ids = local.public_subnet_ids
  alb_sg_id         = local.alb_sg_id
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
}
