# Input variables for the alb module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "public_subnet_ids" {
  description = "IDs of the public subnets the ALB is placed in. Owned by app-base's network module; passed in here (via terraform_remote_state in the app-edge root) rather than looked up directly."
  type        = list(string)
}

variable "alb_sg_id" {
  description = "ID of the ALB's security group. Owned by app-base's ecs-cluster module (so it survives app-edge teardown/recreate); passed in here rather than created."
  type        = string
}
