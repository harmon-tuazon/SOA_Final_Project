# Input variables for the ecs-service module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "region" {
  description = "AWS region the service runs in (used for the task definition's awslogs-region)."
  type        = string
}

variable "name" {
  description = "Short name of the service (e.g. \"items\"). Used to name the ECR repo, log group, roles, security group, and container."
  type        = string
}

variable "port" {
  description = "TCP port the service's container listens on."
  type        = number
}

variable "cpu" {
  description = "Fargate task vCPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "image_tag" {
  description = "Tag of the image to deploy, pushed to this service's ECR repo by CD. Never \"latest\" — always a commit SHA (or \"bootstrap\" for the first apply before any image exists)."
  type        = string
}

variable "health_check_path" {
  description = "HTTP path the ALB target group health-checks against."
  type        = string
  default     = "/health"
}

variable "route" {
  description = "ALB listener-rule path pattern routed to this service (e.g. \"/items*\")."
  type        = string
}

variable "priority" {
  description = "Listener rule evaluation priority. Must be unique across all services sharing the listener."
  type        = number
}

variable "table_arns" {
  description = "ARNs of the DynamoDB tables this service's task role is scoped to. The role is also granted the same actions on each table's index sub-resources (\"<arn>/index/*\")."
  type        = list(string)
  default     = []
}

variable "env" {
  description = "Plain (non-secret) environment variables passed to the container. Secrets are read by the app from SSM/Secrets Manager at runtime, never injected here."
  type        = map(string)
  default     = {}
}

variable "desired_count" {
  description = "Initial desired task count. Ignored on subsequent applies (lifecycle.ignore_changes) so Service Auto Scaling isn't fought by Terraform."
  type        = number
  default     = 1
}

variable "vpc_id" {
  description = "ID of the VPC the service's task security group is created in."
  type        = string
}

variable "public_subnet_ids" {
  description = "IDs of the public subnets the service's tasks run in."
  type        = list(string)
}

variable "cluster_id" {
  description = "ID of the shared ECS cluster this service runs on."
  type        = string
}

variable "alb_sg_id" {
  description = "ID of the shared ALB's security group. The task security group allows the app port from this SG only."
  type        = string
}

variable "listener_arn" {
  description = "ARN of the shared ALB's HTTP listener this service's listener rule attaches to."
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the shared ECS task execution role (ECR pull + log write)."
  type        = string
}

variable "boundary_arn" {
  description = "ARN of the soa-boundary permissions boundary policy, attached to this service's task role. Built as a string by the caller (never looked up via data source)."
  type        = string
}
