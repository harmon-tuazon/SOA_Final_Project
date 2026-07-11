# Output values from the root config.

output "oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC identity provider."
  value       = aws_iam_openid_connect_provider.github_actions.arn
}

output "deployer_role_arn" {
  description = "ARN of the IAM role GitHub Actions assumes (via OIDC) to run Terraform/deploy on the main branch."
  value       = aws_iam_role.deployer.arn
}
