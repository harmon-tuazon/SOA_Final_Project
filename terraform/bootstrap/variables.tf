# Input variables for the bootstrap config.

variable "region" {
  description = "AWS region to create the Terraform remote state bucket in."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Short prefix used to name all resources in this project."
  type        = string
  default     = "soa"
}
