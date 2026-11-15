output "console_url" {
  value = "https://${var.console_host}"
}

output "websocket_url" {
  value = "wss://${var.ws_host}"
}

output "sign_in_url" {
  value = "https://${var.auth_host}"
}

output "github_webhook_url" {
  description = "The webhook the GitHub App delivers to (its secret is the app's own, kept in SSM)."
  value       = "https://${var.console_host}/hooks/github"
}

output "table_name" {
  value = aws_dynamodb_table.platform.name
}

output "function_name" {
  value = aws_lambda_function.platform.function_name
}

output "cognito" {
  value = {
    user_pool_id = aws_cognito_user_pool.console.id
    client_id    = aws_cognito_user_pool_client.console.id
  }
}
