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

# --- Service tables ----------------------------------------------------------
#
# No services are wired here yet. Each new service adds a `data` module
# block (its own DynamoDB table) below — its matching `ecs-service` module
# block goes in terraform/app-edge/main.tf instead. Use `/new-service` to
# scaffold both halves of a service in one PR.
#
# module "example_table" {
#   source = "../modules/data"
#
#   name_prefix = var.name_prefix
#   name        = "example"
#   hash_key    = "id"
# }
