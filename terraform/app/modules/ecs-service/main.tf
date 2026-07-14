# ecs-service module: the reusable "paved road" that turns a container image
# + a DynamoDB table into a running, load-balanced ECS Fargate service behind
# the shared ALB. A second service is one `data` + one `ecs-service` block in
# the root config (PRD platform/0004 §3/§6).
#
# Per-service resources: ECR repo, CloudWatch log group, task role (scoped to
# the service's own table(s), carrying the soa-boundary), task security group
# (app port reachable only from the ALB SG), target group + listener rule,
# task definition (shared execution role + this service's task role), ECS
# service (public subnets, task SG, public IP so the task can reach ECR with
# no NAT), and Service Auto Scaling (CPU target, min 1 / max 2).

# --- ECR repository -----------------------------------------------------

resource "aws_ecr_repository" "this" {
  name                 = "${var.name_prefix}-${var.name}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # so `terraform destroy` on terraform/app is clean even with images still pushed

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- CloudWatch log group -------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name_prefix}-${var.name}"
  retention_in_days = 7

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- Task role -------------------------------------------------------------
#
# The app's own runtime permissions (distinct from the shared execution role,
# which only pulls images and writes logs). `soa-*` name, so it MUST carry
# the soa-boundary for the deployer's scoped iam:CreateRole to succeed.
resource "aws_iam_role" "task" {
  name                 = "${var.name_prefix}-${var.name}-task"
  description          = "Task role for the ${var.name} service: scoped to its own DynamoDB table(s) only."
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

# Customer-managed policy (never an inline aws_iam_role_policy — the deployer
# lacks iam:PutRolePolicy) scoping the task role to exactly its own table(s)
# and their indexes, never account-wide DynamoDB access.
data "aws_iam_policy_document" "task" {
  count = length(var.table_arns) > 0 ? 1 : 0

  statement {
    sid    = "DynamoDbTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:DescribeTable",
    ]
    resources = concat(
      var.table_arns,
      [for arn in var.table_arns : "${arn}/index/*"],
    )
  }
}

resource "aws_iam_policy" "task" {
  count = length(var.table_arns) > 0 ? 1 : 0

  name        = "${var.name_prefix}-${var.name}-task"
  description = "DynamoDB access scoped to the ${var.name} service's own table(s) only."
  policy      = data.aws_iam_policy_document.task[0].json
}

resource "aws_iam_role_policy_attachment" "task" {
  count = length(var.table_arns) > 0 ? 1 : 0

  role       = aws_iam_role.task.name
  policy_arn = aws_iam_policy.task[0].arn
}

# --- Task security group ----------------------------------------------------
#
# The app port is reachable ONLY from the ALB's security group — nothing else
# in the VPC (or the internet, despite the task having a public IP for ECR
# pulls) can reach it directly.
resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-${var.name}-task"
  description = "Task security group for ${var.name}: app port reachable only from the shared ALB."
  vpc_id      = var.vpc_id

  ingress {
    description     = "App port from the ALB only"
    from_port       = var.port
    to_port         = var.port
    protocol        = "tcp"
    security_groups = [var.alb_sg_id]
  }

  egress {
    description = "All outbound (ECR pull, DynamoDB, CloudWatch Logs, etc.)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-${var.name}-task"
  }
}

# --- Target group + listener rule ------------------------------------------

resource "aws_lb_target_group" "this" {
  name        = "${var.name_prefix}-${var.name}"
  port        = var.port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # required for awsvpc-networked Fargate tasks

  health_check {
    path                = var.health_check_path
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

resource "aws_lb_listener_rule" "this" {
  listener_arn = var.listener_arn
  priority     = var.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  condition {
    path_pattern {
      values = [var.route]
    }
  }
}

# --- Task definition ---------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name_prefix}-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = var.name
      image     = "${aws_ecr_repository.this.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = var.port
          protocol      = "tcp"
        }
      ]

      environment = [
        for k, v in var.env : { name = k, value = v }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.name
        }
      }
    }
  ])

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- ECS service ---------------------------------------------------------

resource "aws_ecs_service" "this" {
  name            = "${var.name_prefix}-${var.name}"
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true # no NAT gateway in this design; tasks need a public IP to pull from ECR
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = var.name
    container_port   = var.port
  }

  depends_on = [aws_lb_listener_rule.this]

  lifecycle {
    ignore_changes = [desired_count] # Service Auto Scaling owns this after the initial apply
  }

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- Service Auto Scaling -------------------------------------------------
#
# The appautoscaling resource_id needs the cluster's plain NAME
# ("service/<cluster-name>/<service-name>"), but var.cluster_id (per the
# ecs-cluster module's output contract) carries the cluster ARN. Derive the
# name from the ARN's last "/"-delimited segment rather than adding a
# separate cluster_name input.
locals {
  cluster_name = element(split("/", var.cluster_id), length(split("/", var.cluster_id)) - 1)
}

resource "aws_appautoscaling_target" "this" {
  min_capacity       = 1
  max_capacity       = 2
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name_prefix}-${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 70
  }
}
