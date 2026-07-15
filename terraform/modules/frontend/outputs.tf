# Output values from the frontend module.

output "bucket_name" {
  description = "Name of the S3 bucket hosting the SPA. Read by frontend-cd.yml (sync target) and by backend cd.yml (config.json refresh target)."
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  description = "ARN of the S3 bucket hosting the SPA."
  value       = aws_s3_bucket.frontend.arn
}

output "website_endpoint" {
  description = "HTTP website endpoint the SPA is served from (S3 static website hosting — no HTTPS/CDN yet, see PRD frontend/0001)."
  value       = aws_s3_bucket_website_configuration.frontend.website_endpoint
}
