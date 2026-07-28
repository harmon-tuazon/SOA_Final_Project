# Input variables for the messaging module.

variable "name_prefix" {
  description = "Short prefix used to name all resources created by this module."
  type        = string
}

variable "name" {
  description = "Short name of the queue/topic pair (e.g. \"notifications\"). Combined with name_prefix for the actual resource names."
  type        = string
}

variable "notification_email" {
  description = "One or more email addresses to subscribe to the topic — a single address, or a comma-separated list (\"a@x.ca,b@x.ca\"); one SNS subscription is created per address. Empty string (the default) skips creating subscriptions entirely, so the module can be applied before any address is known/supplied — see docs/to-dos/set-notification-email-variable.md."
  type        = string
  default     = ""
  sensitive   = false
}
