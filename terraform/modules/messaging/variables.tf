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
  description = "Email address to subscribe to the topic. Empty string (the default) skips creating a subscription entirely, so the module can be applied before this address is known/supplied — see docs/to-dos/set-notification-email-variable.md."
  type        = string
  default     = ""
  sensitive   = false
}
