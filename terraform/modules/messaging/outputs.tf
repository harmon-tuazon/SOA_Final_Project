# Output values from the messaging module.

output "queue_url" {
  description = "URL of the work queue. Injected as env into producer services and read by CD's smoke-test step."
  value       = aws_sqs_queue.this.id
}

output "queue_arn" {
  description = "ARN of the work queue. Used to scope a producer's task-role sqs:SendMessage and as the lambda module's source_queue_arn."
  value       = aws_sqs_queue.this.arn
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "topic_arn" {
  description = "ARN of the fan-out SNS topic. Used as the lambda module's publish_topic_arn."
  value       = aws_sns_topic.this.arn
}
