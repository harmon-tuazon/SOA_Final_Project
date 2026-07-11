# Input variables for the root config.

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

variable "github_repo" {
  description = "GitHub repository (in \"owner/repo\" form) allowed to assume the deployer role via OIDC."
  type        = string
  default     = "harmon-tuazon/SOA_Final_Project"
}
