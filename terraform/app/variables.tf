# Input variables for the app config.

variable "region" {
  description = "AWS region all resources are created in. Single-region deployment; change this one value to move regions."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Short prefix used to name all resources in this project."
  type        = string
  default     = "soa"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for the public subnets, one per Availability Zone."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "image_tag" {
  description = "Tag of the container image CD deploys for the items service (a git commit SHA — never \"latest\"). Defaults to \"bootstrap\" so the first apply can create the ECR repo before any image has been pushed; CD overrides this with $GITHUB_SHA on every deploy."
  type        = string
  default     = "bootstrap"
}
