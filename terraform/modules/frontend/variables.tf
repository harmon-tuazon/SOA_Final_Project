# Input variables for the frontend module.

variable "name_prefix" {
  description = "Short prefix used to name the bucket created by this module."
  type        = string
}

variable "account_id" {
  description = "AWS account ID, appended to the bucket name for global uniqueness (S3 bucket names are global across all AWS accounts)."
  type        = string
}
