# Output values from the ecs-cluster module, consumed by the app-base root
# config directly and by app-edge (network + alb modules, ecs-service module
# instances) via terraform_remote_state (PRD platform/0006).

output "cluster_arn" {
  description = "ARN of the shared ECS cluster."
  value       = aws_ecs_cluster.this.arn
}

output "cluster_id" {
  description = "ID of the shared ECS cluster."
  value       = aws_ecs_cluster.this.id
}

output "alb_sg_id" {
  description = "ID of the ALB's security group. Task security groups should allow their app port from this SG only. Owned here (app-base) so it survives app-edge teardown/recreate; app-edge's ALB (modules/alb) references this id, it does not create its own."
  value       = aws_security_group.alb.id
}

output "execution_role_arn" {
  description = "ARN of the shared ECS task execution role (ECR pull + log write), reused by every ecs-service instance."
  value       = aws_iam_role.execution.arn
}
