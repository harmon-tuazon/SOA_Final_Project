# Output values from the ecs-service module.

output "ecr_repository_url" {
  description = "URL of the service's ECR repository, used by CD to build/push and by the task definition to pull."
  value       = aws_ecr_repository.this.repository_url
}

output "ecr_repository_name" {
  description = "Name of the service's ECR repository."
  value       = aws_ecr_repository.this.name
}

output "service_name" {
  description = "Name of the ECS service, used by CD for `aws ecs update-service`."
  value       = aws_ecs_service.this.name
}

output "target_group_arn" {
  description = "ARN of the service's ALB target group."
  value       = aws_lb_target_group.this.arn
}

output "task_role_arn" {
  description = "ARN of the service's task role."
  value       = aws_iam_role.task.arn
}
