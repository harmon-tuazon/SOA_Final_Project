# Input variables for the lambda module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "name" {
  description = "Short name of the function (e.g. \"notification-worker\"). Used to name the function, its exec role/policy, and its log group."
  type        = string
}

variable "handler" {
  description = "Lambda handler entry point (module.exportedFunction)."
  type        = string
  default     = "index.handler"
}

variable "runtime" {
  description = "Lambda runtime. nodejs20.x bundles the AWS SDK v3, so a single-file handler needs no dependency packaging."
  type        = string
  default     = "nodejs20.x"
}

variable "timeout" {
  description = "Function timeout in seconds."
  type        = number
  default     = 10
}

variable "source_file" {
  description = "Path to the single JS file packaged as this function's deployment artifact (zipped by the archive provider, not committed as a zip)."
  type        = string
}

variable "source_queue_arn" {
  description = "ARN of the SQS queue this function consumes via an event source mapping. The exec role is scoped to receive/delete/get-attributes on this queue only."
  type        = string
}

variable "publish_topic_arn" {
  description = "ARN of the SNS topic this function publishes to. The exec role is scoped to sns:Publish on this topic only. Also injected as the TOPIC_ARN env var."
  type        = string
}

variable "boundary_arn" {
  description = "ARN of the soa-boundary permissions boundary policy, attached to this function's execution role. Built as a string by the caller (never looked up via data source)."
  type        = string
}
