# alb module: the single shared internet-facing ALB + HTTP listener,
# created in app-edge (PRD platform/0006) — this is the only billable
# resource created directly in the module tree, and lives in the
# destroyable config on purpose (~$16/mo while up; gone when app-edge is
# destroyed). Internet-facing, sitting directly in the public subnets since
# there's no NAT/private subnet split in this design (ADR 0001). Consumes
# the public subnets and ALB security group as inputs (owned by app-base,
# resolved via terraform_remote_state by the caller) rather than creating
# them — one ALB for the whole app, not one per service (ADR 0001's cost
# trade), and the SG is shared/persistent so it doesn't need re-authoring
# every time the edge is recreated.

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
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

# --- ALB 5xx alarm (optional, PRD platform/0011) -----------------------------
#
# Trips on the ALB's OWN 5xx responses (e.g. no healthy targets, listener
# misconfiguration) rather than a target's application errors, since the
# ELB dimension — not the Target dimension — is the load-balancer-level
# signal. Sum > 5 over one 5-minute period, a small threshold that tolerates
# an isolated blip but catches a sustained failure. Empty alerts_topic_arn
# (the default) creates no alarm, so this module still plans/applies before
# app-base's observability module/output exists.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count = var.alerts_topic_arn != "" ? 1 : 0

  alarm_name          = "${var.name_prefix}-alb-5xx"
  alarm_description   = "The shared ALB (${var.name_prefix}-alb) returned more than 5 HTTP 5xx responses in a 5-minute period."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
  }

  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = {
    Name = "${var.name_prefix}-alb-5xx"
  }
}
