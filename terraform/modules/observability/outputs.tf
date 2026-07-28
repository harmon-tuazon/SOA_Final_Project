# Output values from the observability module.

output "alerts_topic_arn" {
  description = "ARN of the ops-alerts SNS topic. Re-exported by app-base's outputs.tf and read by app-edge via terraform_remote_state to use as an alarm_actions target for the ALB 5xx alarm and each service's ECS CPU-high alarm."
  value       = aws_sns_topic.alerts.arn
}
