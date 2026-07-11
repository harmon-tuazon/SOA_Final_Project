# Pins the Terraform CLI and provider versions used by the bootstrap config.
# This config uses LOCAL state on purpose — it only exists to create the
# remote state bucket that the root config (../) will use.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
