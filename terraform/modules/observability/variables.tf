# Input variables for the observability module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "notification_email" {
  description = "One or more email addresses to subscribe to the ops-alerts topic and the cost budget — a single address, or a comma-separated list (\"a@x.ca,b@x.ca\"); one SNS subscription is created per address. Empty string (the default) skips creating email subscriptions/addresses entirely — the budget notifications still fire to the alerts topic regardless."
  type        = string
  default     = ""
}

variable "budget_limit_amount" {
  description = "Monthly cost budget limit, in USD (as a string, per the aws_budgets_budget resource's schema)."
  type        = string
  default     = "30"
}

variable "lambda_function_name" {
  description = "Name of a Lambda function to alarm on its Errors metric (e.g. the notification worker). Empty (the default) creates no alarm."
  type        = string
  default     = ""
}
