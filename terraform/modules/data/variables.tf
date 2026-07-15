# Input variables for the data module.

variable "name_prefix" {
  description = "Short prefix used to name the table created by this module."
  type        = string
}

variable "name" {
  description = "Short name of the table, usually matching the owning service (e.g. \"items\"). Combined with name_prefix for the actual table name."
  type        = string
}

variable "hash_key" {
  description = "Name of the table's partition (hash) key attribute. Always typed as a string (\"S\") attribute."
  type        = string
}
