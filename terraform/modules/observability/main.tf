# observability module: the ops-alerts SNS topic (+ email subscriptions), a
# monthly cost budget, and (optionally) a CloudWatch alarm on a Lambda
# function's Errors metric — PRD platform/0011's monitoring rubric item.
# Lives in app-base (permanent, free) so the alerts topic and budget survive
# every app-edge teardown; app-edge's ecs-service/alb instances read the
# topic ARN back via terraform_remote_state (app-base's output) to attach
# their own alarms (ECS CPU high, ALB 5xx) as alarm_actions, rather than
# recreating a topic of their own.

# --- Alerts topic -------------------------------------------------------------
#
# Same split-into-one-subscription-per-address pattern as modules/messaging
# (a single address or "a@x.ca,b@x.ca" — one SNS subscription per address).
# AWS still emails each endpoint a confirmation link a human must click once
# before delivery starts (see docs/to-dos/confirm-sns-subscription.md); an
# empty value yields zero email subscriptions, so this module still
# plans/applies before any recipient is supplied.
resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-alerts"

  tags = {
    Name = "${var.name_prefix}-alerts"
  }
}

locals {
  notification_emails = [
    for e in split(",", var.notification_email) : trimspace(e)
    if trimspace(e) != ""
  ]
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(local.notification_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Monthly cost budget -----------------------------------------------------
#
# AWS Budgets: the first two budgets per account are free. Every notification
# always includes the alerts topic as a subscriber (so the budget still
# plans/applies and actually notifies even before notification_email is set —
# same fail-soft posture as the email subscriptions above), plus the email
# addresses directly when supplied. Thresholds: 80% and 100% of ACTUAL spend,
# plus a FORECASTED>100% warning so a cost trend is flagged before the month
# closes.
resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly-cost"
  budget_type  = "COST"
  limit_amount = var.budget_limit_amount
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
    subscriber_email_addresses = local.notification_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
    subscriber_email_addresses = local.notification_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
    subscriber_email_addresses = local.notification_emails
  }
}

# --- Lambda errors alarm (optional) ------------------------------------------
#
# Alarms on the async worker's Errors metric (AWS/Lambda) — 1+ error in a
# single 5-minute period trips it. Lives here (not the lambda module itself)
# so a single alerts topic serves every alarm this module owns; the function
# name is passed in as a plain string (never a cross-module resource
# reference — modules never reach into each other, per the wiring rule).
# Empty (default) creates no alarm, so existing/other callers of this module
# aren't forced to wire a Lambda.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count = var.lambda_function_name != "" ? 1 : 0

  # var.lambda_function_name is already fully-qualified (e.g.
  # "soa-notification-worker" — the lambda module's own
  # "${name_prefix}-${name}" output), so it is NOT re-prefixed here.
  alarm_name          = "${var.lambda_function_name}-errors"
  alarm_description   = "1 or more Lambda errors for ${var.lambda_function_name} in a 5-minute period."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = var.lambda_function_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = {
    Name = "${var.lambda_function_name}-errors"
  }
}
