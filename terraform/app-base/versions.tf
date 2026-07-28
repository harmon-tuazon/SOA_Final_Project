# Pins the Terraform CLI and provider versions for the app-base config.
# The `archive` provider is used once, by the `lambda` module, to zip the
# notification worker's single-file handler (PRD platform/0008) — Terraform
# owns packaging end-to-end, no committed zip artifact.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}
