# Output values from the app-base config. Re-exported from the network and
# cluster modules; consumed both directly (CD, humans) and by app-edge via
# terraform_remote_state (PRD platform/0006).

output "vpc_id" {
  description = "ID of the VPC created for the app's network. Read by app-edge via terraform_remote_state."
  value       = module.network.vpc_id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets, one per Availability Zone. Read by app-edge via terraform_remote_state (ALB + task placement)."
  value       = module.network.public_subnet_ids
}

output "vpc_cidr" {
  description = "CIDR block of the VPC."
  value       = module.network.vpc_cidr
}

output "cluster_id" {
  description = "ID of the shared ECS cluster. Read by app-edge via terraform_remote_state; also used by CD's `aws ecs wait services-stable`."
  value       = module.cluster.cluster_id
}

output "cluster_arn" {
  description = "ARN of the shared ECS cluster."
  value       = module.cluster.cluster_arn
}

output "execution_role_arn" {
  description = "ARN of the shared ECS task execution role. Read by app-edge via terraform_remote_state; every ecs-service instance's task definition uses this."
  value       = module.cluster.execution_role_arn
}

output "alb_sg_id" {
  description = "ID of the ALB's security group (owned here so it survives app-edge teardown/recreate). Read by app-edge via terraform_remote_state; the app-edge ALB references this id rather than creating its own."
  value       = module.cluster.alb_sg_id
}

output "frontend_bucket_name" {
  description = "Name of the S3 bucket hosting the React SPA. Read by frontend-cd.yml (sync target) and backend cd.yml (config.json refresh target)."
  value       = module.frontend.bucket_name
}

output "frontend_website_endpoint" {
  description = "HTTP website endpoint the SPA is served from (S3 static website hosting)."
  value       = module.frontend.website_endpoint
}
