# data module: one DynamoDB table per service (polyglot persistence — no
# shared database between services, per CLAUDE.md / ADR 0001). On-demand
# billing (PAY_PER_REQUEST) so an idle table costs nothing and there's no
# capacity to size or right-size.

resource "aws_dynamodb_table" "this" {
  name         = "${var.name_prefix}-${var.name}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = var.hash_key

  attribute {
    name = var.hash_key
    type = "S"
  }

  tags = {
    Name = "${var.name_prefix}-${var.name}"
  }
}
