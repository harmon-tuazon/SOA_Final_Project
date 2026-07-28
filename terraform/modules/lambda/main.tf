# lambda module: a single-file Node.js worker plus its own execution role,
# log group, and (optionally) an SQS event source mapping — the consumer half
# of the async factory (PRD platform/0008, ADR 0001's SQS -> Lambda -> SNS
# pattern). Pairs with the `messaging` module, whose queue_arn/topic_arn feed
# this module's source_queue_arn/publish_topic_arn.
#
# Deviation from the PRD's originally sketched packaging (a committed
# bootstrap.zip pushed by CD via `aws lambda update-function-code`, with
# lifecycle.ignore_changes on the function code): this module packages the
# function directly with the hashicorp/archive provider, zipping ONLY
# var.source_file, and lets source_code_hash drive redeploys. The nodejs20.x
# runtime bundles the AWS SDK v3, so a worker like this needs no npm install
# step and no dependency bundling — a single handler file is the whole
# artifact, and Terraform can own code deploys end-to-end with no separate
# CD `update-function-code` step and no ignore_changes fighting the applier.

# --- Package the handler -----------------------------------------------------

data "archive_file" "this" {
  type        = "zip"
  source_file = var.source_file
  output_path = "${path.module}/builds/${var.name_prefix}-${var.name}.zip"
}

# --- Log group -----------------------------------------------------------------
#
# Created explicitly (rather than left to Lambda's implicit auto-create) so
# retention is set from day one and the exec role's log policy can scope to
# this exact group ARN. aws_lambda_function depends_on this so the function
# never races Lambda's own auto-create of an unmanaged, unretained group.
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name_prefix}-${var.name}"
  retention_in_days = 7 # matches the ecs-service module's log group retention

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- Execution role ------------------------------------------------------------
#
# `soa-*` name, so it MUST carry the soa-boundary for the deployer's scoped
# iam:CreateRole to succeed — same pattern as every ECS task role in
# modules/ecs-service. The boundary already permits sqs:Receive*/DeleteMessage
# and sns:Publish (terraform/iam.tf), so this role's own policy only needs to
# narrow the boundary's account-wide ceiling down to this function's specific
# queue, topic, and log group.
resource "aws_iam_role" "exec" {
  name                 = "${var.name_prefix}-${var.name}-exec"
  description          = "Execution role for the ${var.name} Lambda: scoped to its own source queue, publish topic, and log group only."
  permissions_boundary = var.boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# Customer-managed policy (never an inline aws_iam_role_policy — the deployer
# lacks iam:PutRolePolicy — and never an AWS-managed policy like
# AWSLambdaBasicExecutionRole/AWSLambdaSQSQueueExecutionRole, since the
# deployer's AttachRolePolicy is restricted to policy/soa-* ARNs). Triple-
# scoped: the queue this function consumes, the topic it publishes to, and
# only its own log group/streams — never account-wide sqs:*/sns:*/logs:*.
data "aws_iam_policy_document" "exec" {
  statement {
    sid    = "SqsConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.source_queue_arn]
  }

  statement {
    sid       = "SnsPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [var.publish_topic_arn]
  }

  statement {
    sid    = "LogsWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_policy" "exec" {
  name        = "${var.name_prefix}-${var.name}-exec"
  description = "SQS consume + SNS publish + log write, scoped to the ${var.name} Lambda's own queue/topic/log group only."
  policy      = data.aws_iam_policy_document.exec.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = aws_iam_policy.exec.arn
}

# --- Function --------------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name = "${var.name_prefix}-${var.name}"
  role          = aws_iam_role.exec.arn
  runtime       = var.runtime
  handler       = var.handler
  timeout       = var.timeout

  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256

  environment {
    variables = {
      TOPIC_ARN = var.publish_topic_arn
    }
  }

  # So the function's log stream lands in the explicitly-managed group above
  # (with its retention set) instead of racing Lambda's own implicit
  # auto-create of an unmanaged, unretained group on first invocation.
  depends_on = [aws_cloudwatch_log_group.this]

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}

# --- SQS event source mapping -----------------------------------------------
#
# ReportBatchItemFailures lets the handler fail individual records within a
# batch (by returning their message IDs in `batchItemFailures`) without the
# whole batch being retried/redriven — a malformed record doesn't take down
# its batch-mates.
resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn = var.source_queue_arn
  function_name    = aws_lambda_function.this.arn
  batch_size       = 10

  function_response_types = ["ReportBatchItemFailures"]
}
