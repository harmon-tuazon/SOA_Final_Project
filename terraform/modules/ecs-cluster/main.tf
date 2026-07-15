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
