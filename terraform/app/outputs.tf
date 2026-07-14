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
