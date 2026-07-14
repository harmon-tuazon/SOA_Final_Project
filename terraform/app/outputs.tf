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

output "ecs_cluster_id" {
  description = "ARN of the shared ECS cluster, used by CD's `aws ecs wait services-stable`."
  value       = module.cluster.cluster_id
}
