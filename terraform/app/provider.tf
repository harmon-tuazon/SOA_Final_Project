# Configures the AWS provider for the app config. Every resource created by
# this config picks up the default tags below automatically.

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "soa"
      ManagedBy = "terraform"
    }
  }
}
