# Input variables for the ecs-cluster module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC the cluster's ALB security group and tasks run in."
  type        = string
}

variable "boundary_arn" {
  description = "ARN of the soa-boundary permissions boundary policy, attached to the ECS task execution role created here. Built as a string by the caller (never looked up via data source), since the deployer's IAM permissions don't include iam:ListPolicies."
  type        = string
}

variable "mesh_port" {
  description = "TCP app port the shared mesh security group allows from its own members (PRD platform/0012). All services currently listen on the same conventional port (service-contract.md), so one value covers every service."
  type        = number
  default     = 3000
}
