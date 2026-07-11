# Output values from the bootstrap config.

output "state_bucket_name" {
  description = "Name of the S3 bucket created to hold Terraform remote state for the root config. Use this value (or the pattern it follows) as the `bucket` in ../backend.tf."
  value       = aws_s3_bucket.tfstate.bucket
}
