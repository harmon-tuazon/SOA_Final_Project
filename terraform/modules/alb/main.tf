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
