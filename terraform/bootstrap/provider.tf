# Configures the AWS provider for the bootstrap config. Single region,
# no default tags needed here since this creates only one bucket.

provider "aws" {
  region = var.region
}
