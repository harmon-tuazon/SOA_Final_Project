# Creates the one and only resource this bootstrap config manages: the S3
# bucket that the root Terraform config (../) uses as its remote state
# backend. Run once, by hand, before the root config's `terraform init`.
#
# This bucket is intentionally permanent — it is NOT destroyed as part of the
# normal `terraform destroy` teardown cycle for the rest of the project,
# because destroying it would orphan the root config's state.

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "tfstate" {
  bucket = "${var.name_prefix}-tfstate-${data.aws_caller_identity.current.account_id}"

  # Protected from *accidental* deletion, but still deletable on purpose.
  # With force_destroy = false (the default, set explicitly) AWS refuses to
  # delete this bucket while it still holds objects — and versioning keeps it
  # non-empty — so a careless `terraform destroy` against this bootstrap
  # config errors out instead of wiping the state. To delete deliberately:
  # empty the bucket (or set force_destroy = true), then destroy.
  force_destroy = false
}

# Versioning lets us recover from a bad state write by rolling back to a
# previous object version.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Encrypt state at rest. State can contain sensitive values, so this is not
# optional.
resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Block every form of public access. State must never be reachable from the
# internet.
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
