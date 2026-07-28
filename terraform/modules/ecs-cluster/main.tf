# ecs-cluster module: the shared, cluster-wide compute resources created
# once for the whole app and lived in app-base (PRD platform/0006 — the
# free, permanent foundation) — the ECS Fargate cluster, its security group
# for the ALB (referenced, not owned, by the ALB), and the ECS task
# execution role every service's task definition shares (ECR pull +
# CloudWatch Logs write only — never the app's own data-plane permissions,
# which live on each service's task role instead).
#
# The ALB + HTTP listener themselves live in app-edge (the modules/alb/
# module), NOT here: the ALB is the only billable resource in this whole
# module tree, and app-base must stay 100% free/permanent (ADR 0002 /
# platform/0006). The ALB security group stays here because it only
# references the VPC (free) and is reused as-is by app-edge's ALB via
# remote state — creating it in app-base means it survives an `app-edge
# destroy` and doesn't need to be recreated (and re-authorized) every time
# the edge comes back up.

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# Associates both FARGATE and FARGATE_SPOT with the cluster (PRD
# platform/0010): required before any service can request Spot capacity.
# FARGATE stays associated too so a service can flip back to on-demand
# (ecs-service's `use_fargate_spot = false`) with no change here. No
# `default_capacity_provider_strategy` is set — each service's own
# `capacity_provider_strategy` block decides Spot vs. on-demand.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# --- ALB security group -----------------------------------------------------
#
# Inbound :80 from the internet (this is the public entry point for every
# service behind the shared ALB); egress open so the ALB can reach tasks on
# whatever port they listen on across the VPC. Lives here (app-base) rather
# than with the ALB itself (app-edge) so it persists across `app-edge`
# teardown/recreate cycles.
resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Shared ALB security group: inbound HTTP from the internet, outbound to tasks."
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from the internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-alb"
  }
}

# --- Shared ECS task execution role ------------------------------------------
#
# One execution role reused across every service's task definition: it only
# ever needs to pull the service's image from ECR and write its own logs, so
# there is nothing service-specific about it and no reason to mint one per
# service. `soa-*` name, so it MUST carry the soa-boundary permissions
# boundary for the deployer's scoped iam:CreateRole to succeed (see PRD
# platform/0001/0002 and CLAUDE.md IAM constraints).
resource "aws_iam_role" "execution" {
  name                 = "${var.name_prefix}-ecs-execution"
  description          = "Shared ECS task execution role: pulls container images from ECR and writes task logs to CloudWatch. Never carries application data-plane permissions."
  permissions_boundary = var.boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Customer-managed policy (never an AWS-managed policy like
# AmazonECSTaskExecutionRolePolicy — the deployer's AttachRolePolicy is
# restricted to policy/soa-* ARNs only) granting exactly the ECR-pull and
# CloudWatch Logs-write actions the ECS agent needs to start a task and
# stream its logs.
data "aws_iam_policy_document" "execution" {
  statement {
    sid    = "EcrPull"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "LogsWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:CreateLogGroup",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "execution" {
  name        = "${var.name_prefix}-ecs-execution"
  description = "ECR pull + CloudWatch Logs write for the shared ECS task execution role."
  policy      = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = aws_iam_policy.execution.arn
}

# --- Service Connect namespace (PRD platform/0012) --------------------------
#
# HTTP Cloud Map namespace every service's ecs-service instance joins via
# `service_connect_configuration`, so tasks reach each other by a stable
# logical name (e.g. http://product:3000) instead of a churning task IP or
# the public ALB. Free — an HTTP namespace and Service Connect carry no
# separate AWS charge (only the small task cpu/mem the injected Envoy
# sidecar consumes, sized via ecs-service's cpu/memory variables). Lives
# here (app-base) so the namespace survives every app-edge teardown/recreate
# — app-edge's services join it via terraform_remote_state, they never
# create it.
resource "aws_service_discovery_http_namespace" "this" {
  name        = var.name_prefix
  description = "Service Connect namespace for internal service-to-service discovery (PRD platform/0012)."
}

# --- Shared internal "mesh" security group (PRD platform/0012) --------------
#
# Every service's task attaches this SG in ADDITION to its own ALB-scoped
# task SG (modules/ecs-service keeps that unchanged). It trusts only ITSELF
# (self = true) on the app port, so any task carrying this SG can reach any
# other task carrying it with no per-pair wiring as services are added — the
# mesh only ever admits traffic already inside the cluster's own tasks; the
# public/ALB ingress path is untouched. Lives here (app-base) so it is
# created once and survives every app-edge teardown/recreate.
resource "aws_security_group" "mesh" {
  name        = "${var.name_prefix}-mesh"
  description = "Shared internal security group for service-to-service (Service Connect) traffic: trusts only its own members on the app port."
  vpc_id      = var.vpc_id

  ingress {
    description = "App port from other tasks carrying this same security group (self-referencing, not open to the internet or the ALB path)"
    from_port   = var.mesh_port
    to_port     = var.mesh_port
    protocol    = "tcp"
    self        = true
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-mesh"
  }
}
