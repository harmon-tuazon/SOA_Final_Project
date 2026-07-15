# Output values from the data module.

output "name" {
  description = "Name of the DynamoDB table."
  value       = aws_dynamodb_table.this.name
}

output "arn" {
  description = "ARN of the DynamoDB table."
  value       = aws_dynamodb_table.this.arn
}
