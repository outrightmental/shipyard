# The HTTP API: the console's calls (/api/…, behind the Cognito JWT
# authorizer), the fleet's (/enroll and /fleet/…, each with a credential of its
# own that the function checks) and the webhooks (/hooks/…, signed by their own
# secret). Reached through CloudFront on the console's origin (console.tf), so
# the browser makes no cross-origin call; the raw execute-api hostname answers
# too, with the same authorizer in front.
resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-http"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "http" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.platform.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.console.id]
    issuer   = "https://cognito-idp.${local.aws_region}.amazonaws.com/${aws_cognito_user_pool.console.id}"
  }
}

# The console: only a signed-in operator.
resource "aws_apigatewayv2_route" "api" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "ANY /api/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.http.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# The routes with no operator's JWT. Each proves itself to the function:
#   /enroll        a machine redeems its one-time code for its token (tools/enroll.ts)
#   /fleet/…       a fleet member, by its token (src/fleet/uplink.ts)
#   /hooks/…       GitHub, by the webhook's signature
#   /healthz       nothing to prove: the commit the platform runs
resource "aws_apigatewayv2_route" "open" {
  for_each = toset([
    "ANY /enroll",
    "ANY /enroll/{proxy+}",
    "ANY /fleet/{proxy+}",
    "ANY /hooks/{proxy+}",
    "GET /healthz",
  ])

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.http.id}"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.http_api.arn
    format = jsonencode({
      requestId = "$context.requestId", ip = "$context.identity.sourceIp", requestTime = "$context.requestTime",
      method    = "$context.httpMethod", path = "$context.path", status = "$context.status", latency = "$context.responseLatency",
      error     = "$context.error.message", authorizer = "$context.authorizer.error",
    })
  }

  default_route_settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_cloudwatch_log_group" "http_api" {
  name              = "/aws/apigateway/${local.name}-http"
  retention_in_days = 14
}

resource "aws_lambda_permission" "http_api" {
  statement_id  = "apigateway-http"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.platform.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
