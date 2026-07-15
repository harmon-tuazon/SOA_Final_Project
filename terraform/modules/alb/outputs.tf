# Output values from the alb module, consumed by the app-edge root config
# and by ecs-service module instances (listener_arn).

output "alb_arn" {
  description = "ARN of the shared Application Load Balancer."
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "Public DNS name of the shared ALB. Base URL for every service behind it (e.g. http://<alb_dns_name>/items). Changes on every app-edge destroy/recreate cycle — never hardcode it, always read it from this output / CD's deploy output (see service-contract.md's no-hardcoded-endpoint rule)."
  value       = aws_lb.this.dns_name
}

output "listener_arn" {
  description = "ARN of the shared HTTP :80 listener. ecs-service instances attach path-based listener rules to this."
  value       = aws_lb_listener.http.arn
}
