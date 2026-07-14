# Output values from the ecs-cluster module, consumed by the app root config
# and by ecs-service module instances.

output "cluster_arn" {
  description = "ARN of the shared ECS cluster."
  value       = aws_ecs_cluster.this.arn
}

output "cluster_id" {
  description = "ID of the shared ECS cluster."
  value       = aws_ecs_cluster.this.id
}

output "alb_arn" {
  description = "ARN of the shared Application Load Balancer."
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "Public DNS name of the shared ALB."
  value       = aws_lb.this.dns_name
}

output "alb_sg_id" {
  description = "ID of the ALB's security group. Task security groups should allow their app port from this SG only."
  value       = aws_security_group.alb.id
}

output "listener_arn" {
  description = "ARN of the shared HTTP :80 listener. ecs-service instances attach path-based listener rules to this."
  value       = aws_lb_listener.http.arn
}

output "execution_role_arn" {
  description = "ARN of the shared ECS task execution role (ECR pull + log write), reused by every ecs-service instance."
  value       = aws_iam_role.execution.arn
}
