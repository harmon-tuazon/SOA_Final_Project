# Output values from the app-edge config, re-exported from the alb module.

output "alb_dns_name" {
  description = "Public DNS name of the shared ALB. Base URL for every service behind it (e.g. http://<alb_dns_name>/items). Changes on every app-edge destroy/recreate cycle — consumers must read this from config/env, never hardcode it (see service-contract.md's no-hardcoded-endpoint rule)."
  value       = module.alb.alb_dns_name
}

output "listener_arn" {
  description = "ARN of the shared HTTP :80 listener. Used when wiring a new service's ecs-service module block."
  value       = module.alb.listener_arn
}
