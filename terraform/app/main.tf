# Wires the app config's modules together. This is a thin root: modules do
# the actual resource creation, this file just passes inputs between them.

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
# creates (ECS task roles, ECS task execution role) MUST set this as its
# permissions_boundary, or the deployer's scoped iam:CreateRole (conditioned
# on this exact boundary) fails with AccessDenied.
locals {
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-boundary"
}

module "network" {
  source = "./modules/network"

  name_prefix         = var.name_prefix
  vpc_cidr            = var.vpc_cidr
  public_subnet_cidrs = var.public_subnet_cidrs
  azs                 = slice(data.aws_availability_zones.available.names, 0, length(var.public_subnet_cidrs))
}

# --- Shared compute: ECS cluster + ALB (created once) -----------------------

module "cluster" {
  source = "./modules/ecs-cluster"

  name_prefix       = var.name_prefix
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  boundary_arn      = local.boundary_arn
}

# --- Services --------------------------------------------------------------
#
# No services are wired here yet. Each new service adds a `data` module
# (its own DynamoDB table) + an `ecs-service` module (its ECS
# service/task/listener rule) block below, following the pattern retired
# with `items` (PRD platform/0005). Use `/new-service` to scaffold one.
