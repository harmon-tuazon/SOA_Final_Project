# messaging module: the reusable async "factory" the architecture has always
# described but never had — a work queue with a dead-letter queue, and an SNS
# topic for fan-out (PRD platform/0008, the SQS → Lambda → SNS pattern from
# ADR 0001). Standard (not FIFO) queue: notifications tolerate a rare
# duplicate and need no ordering. Pairs with the `lambda` module, which
# consumes `queue_arn` and publishes to `topic_arn`.

# --- Dead-letter queue -------------------------------------------------------
#
# Catches messages the worker fails to process after maxReceiveCount
# attempts, so a poison message can't hot-loop the Lambda or block the main
# queue. Inspected manually, not consumed by anything automatically.
resource "aws_sqs_queue" "dlq" {
  name = "${var.name_prefix}-${var.name}-dlq"

  tags = {
    Name = "${var.name_prefix}-${var.name}-dlq"
  }
}

# --- Work queue ---------------------------------------------------------------
#
# visibility_timeout_seconds is set well above the worker Lambda's timeout
# (AWS guidance: at least 6x) so a message can't become visible again and be
# double-processed while the worker is still handling it.
resource "aws_sqs_queue" "this" {
  name                       = "${var.name_prefix}-${var.name}"
  visibility_timeout_seconds = 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- Fan-out topic -------------------------------------------------------------

resource "aws_sns_topic" "this" {
  name = "${var.name_prefix}-${var.name}"

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# Email subscription: Terraform can create the subscription object, but AWS
# emails the endpoint a confirmation link that a human must click once before
# delivery starts (SNS email subscriptions cannot be fully automated). See
# docs/to-dos/confirm-sns-subscription.md. Defaulting notification_email to
# "" (count = 0) lets CI/CD plan and apply this module before the recipient
# address exists as a variable value — the subscription is added on a later
# apply once the address is supplied.
resource "aws_sns_topic_subscription" "email" {
  count = var.notification_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.this.arn
  protocol  = "email"
  endpoint  = var.notification_email
}
