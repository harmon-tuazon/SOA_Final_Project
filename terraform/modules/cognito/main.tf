# cognito module: the application's identity provider. One user pool + one
# PUBLIC app client (no secret) for the browser SPA, which calls Cognito's
# SignUp / ConfirmSignUp / InitiateAuth APIs directly over HTTPS. No hosted
# UI, so no domain and no callback URLs — that is what would have required
# HTTPS redirect URIs (see ADR 0005).

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # Sign in with email; Cognito owns email uniqueness, so no service needs
  # its own email index.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your verification code"
    email_message        = "Your verification code is {####}"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false
  }

  # soa-deployer holds cognito-idp:* — this makes deleting the pool (and
  # every account in it) a deliberate human action, mirroring the
  # DeleteTable denial that protects service tables.
  deletion_protection = "ACTIVE"

  tags = {
    Name = "${var.name_prefix}-users"
  }
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.name_prefix}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  # A browser client cannot keep a secret. Public client is required.
  generate_secret = false

  # SRP only — the password never goes on the wire. USER_PASSWORD_AUTH is
  # deliberately absent.
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Don't leak whether an email is registered.
  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
