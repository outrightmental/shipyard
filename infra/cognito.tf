# The console's sign-in: a Cognito user pool, one app client for the static
# console (public, no secret), and the operator's account, created with an
# invitation to the email given. Nobody signs up: an operator is added here,
# and to start there is exactly one. The pages the operator signs in on are
# the console's own, at the sign-in host (auth.tf), which call the pool's API:
# the pool has no domain, so none of Cognito's hosted pages is served anywhere.
resource "aws_cognito_user_pool" "console" {
  name = "${local.name}-console"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your Shipyard account"
      email_message = "Sign in at https://${var.console_host} as {username} with the temporary password {####}. You will choose your own password on first sign-in."
      sms_message   = "Shipyard: {username} / {####}"
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_pool_client" "console" {
  name         = "${local.name}-console"
  user_pool_id = aws_cognito_user_pool.console.id

  generate_secret = false

  # The sign-in pages (auth.tf) send the password to the pool's API over TLS;
  # the console refreshes and revokes with the refresh token. No OAuth: no
  # hosted page to send to.
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"]
  allowed_oauth_flows_user_pool_client = false
  allowed_oauth_flows                  = []
  allowed_oauth_scopes                 = []
  callback_urls                        = []
  logout_urls                          = []
  supported_identity_providers         = ["COGNITO"]
  enable_token_revocation              = true
  prevent_user_existence_errors        = "ENABLED"

  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 30
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}

# The operator: invited by email with a temporary password.
resource "aws_cognito_user" "operator" {
  user_pool_id             = aws_cognito_user_pool.console.id
  username                 = var.operator_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.operator_email
    email_verified = "true"
  }

  lifecycle {
    ignore_changes = [temporary_password, password]
  }
}
