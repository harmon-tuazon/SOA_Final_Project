# Pins the Terraform CLI and provider versions for the root config.
# The `tls` provider is used once, to derive the GitHub OIDC thumbprint
# dynamically (see iam.tf) instead of hardcoding it.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
