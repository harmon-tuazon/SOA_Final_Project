# Input variables for the app-edge config.

variable "region" {
  description = "AWS region all resources are created in. Single-region deployment; change this one value to move regions. Must match app-base's region (both read/write the same VPC/subnets)."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Short prefix used to name all resources in this project. Must match app-base's name_prefix (used to derive the boundary ARN and to read app-base's state)."
  type        = string
  default     = "soa"
}

variable "image_tag" {
  description = "Tag of the container image CD deploys for each service (a git commit SHA — never \"latest\"). Defaults to \"bootstrap\" so the first apply can create an ECR repo before any image has been pushed; CD overrides this with $GITHUB_SHA on every deploy. Currently unused until a service module consumes it again."
  type        = string
  default     = "bootstrap"
}

# --- Cross-config wiring: reading app-base's state --------------------------
#
# terraform_remote_state data sources (unlike the `terraform { backend }`
# block) CAN take variables, so the state bucket name — which embeds the AWS
# account id and is deliberately kept out of committed files, same as
# backend.hcl — is supplied here instead of hardcoded. Set it the same way
# as everywhere else this project keeps the bucket name local-only: a
# gitignored terraform.tfvars (see terraform.tfvars.example) or
# TF_VAR_state_bucket in CI. `terraform validate` does not require a value
# (data sources aren't evaluated); `plan`/`apply` do.
variable "state_bucket" {
  description = "Name of the shared Terraform state bucket (same one this config's own backend.tf points at), used to read app-base's outputs via terraform_remote_state. Never hardcoded/committed — see backend.hcl.example for the equivalent pattern."
  type        = string
}
