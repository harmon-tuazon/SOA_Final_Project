# Input variables for the network module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the public subnets, one per Availability Zone."
  type        = list(string)
}

variable "azs" {
  description = "Availability Zones to place the public subnets in, one per subnet CIDR (same order/length as public_subnet_cidrs)."
  type        = list(string)
}
