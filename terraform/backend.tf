# Remote state backend: the S3 bucket created by terraform/bootstrap/.
#
# Backend blocks cannot reference variables or interpolation, so these
# values have to be hardcoded here. The bucket name is deliberately left
# out — it embeds the AWS account id, which shouldn't live in a committed
# file — and is supplied at `terraform init` time via a gitignored
# `-backend-config` file instead:
#
#   terraform init -backend-config=backend.hcl
#
# See backend.hcl.example for the template; copy it to backend.hcl (which
# is gitignored) and fill in the real bucket name. The bucket name must
# match the one terraform/bootstrap/ created:
#   "${name_prefix}-tfstate-${account_id}"
#
# Native S3 locking (use_lockfile) requires Terraform >= 1.10 and needs no
# separate DynamoDB lock table.

terraform {
  backend "s3" {
    key          = "platform/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
