# Output values from the lambda module.

output "function_name" {
  description = "Name of the Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function."
  value       = aws_lambda_function.this.arn
}

output "exec_role_arn" {
  description = "ARN of the function's execution role."
  value       = aws_iam_role.exec.arn
}
