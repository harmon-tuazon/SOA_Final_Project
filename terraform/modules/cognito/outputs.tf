# Output values from the cognito module.

output "user_pool_id" {
  description = "ID of the application Cognito user pool. Non-secret — published to the SPA in config.json by cd.yml, and read by app-edge via terraform_remote_state for the user service's env."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "ARN of the application Cognito user pool. Non-secret — read by app-edge via terraform_remote_state for the user service's env."
  value       = aws_cognito_user_pool.this.arn
}

output "client_id" {
  description = "ID of the public SPA app client (no secret). Non-secret — published to the SPA in config.json by cd.yml."
  value       = aws_cognito_user_pool_client.spa.id
}
