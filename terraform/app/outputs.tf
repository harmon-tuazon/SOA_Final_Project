# Output values from the app config, re-exported from the network module.

output "vpc_id" {
  description = "ID of the VPC created for the app's network."
  value       = module.network.vpc_id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets, one per Availability Zone."
  value       = module.network.public_subnet_ids
}

output "vpc_cidr" {
  description = "CIDR block of the VPC."
  value       = module.network.vpc_cidr
}

output "alb_dns_name" {
  description = "Public DNS name of the shared ALB. Base URL for every service behind it (e.g. http://<alb_dns_name>/items)."
  value       = module.cluster.alb_dns_name
}

output "items_ecr_repository_url" {
  description = "URL of the items service's ECR repository, used by CD to build/push the image before each deploy."
  value       = module.items_service.ecr_repository_url
}

output "ecs_cluster_id" {
  description = "ARN of the shared ECS cluster, used by CD's `aws ecs wait services-stable`."
  value       = module.cluster.cluster_id
}

output "items_service_name" {
  description = "Name of the items ECS service, used by CD's `aws ecs wait services-stable`."
  value       = module.items_service.service_name
}
