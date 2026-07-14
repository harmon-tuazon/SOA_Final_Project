# Input variables for the ecs-cluster module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC the cluster's ALB and tasks run in."
  type        = string
}

variable "public_subnet_ids" {
  description = "IDs of the public subnets the ALB is placed in."
  type        = list(string)
}

variable "boundary_arn" {
  description = "ARN of the soa-boundary permissions boundary policy, attached to the ECS task execution role created here. Built as a string by the caller (never looked up via data source), since the deployer's IAM permissions don't include iam:ListPolicies."
  type        = string
}
