# ecs-cluster module: the shared, cluster-wide compute resources created
# once for the whole app — the ECS Fargate cluster, the single internet-
# facing ALB (in the public subnets, per ADR 0001's no-NAT-gateway cost
# trade-off), its security group, an HTTP :80 listener with a default
# fixed-response 404 (real routes are added by ecs-service instances via
# listener rules), and the ECS task execution role every service's task
# definition shares (ECR pull + CloudWatch Logs write only — never the
# app's own data-plane permissions, which live on each service's task
# role instead).

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
# whatever port they listen on across the VPC.
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

# --- Shared ALB --------------------------------------------------------------
#
# One ALB for the whole app (not one per service) — a deliberate cost trade
# (ADR 0001). Internet-facing, sitting directly in the public subnets since
# there's no NAT/private subnet split in this design.
resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  tags = {
    Name = "${var.name_prefix}-alb"
  }
}

# HTTP-only listener (no ACM/domain yet — see PRD platform/0004 §9). Default
# action is a fixed 404 response; each ecs-service instance registers its own
# path-based listener rule on this listener for its route.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
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
