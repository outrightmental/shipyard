# The WebSocket API: the consoles (a Cognito id token on $connect) and the
# fleet members (their own token on $connect), at its own hostname. It is the
# push channel only: every event a member's engines emit reaches the consoles
# through it, and an operator's decision reaches the member it is for. A
# machine behind NAT cannot be called, so it holds this connection open.
resource "aws_apigatewayv2_api" "websocket" {
  name                       = "${local.name}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.t"
}

resource "aws_apigatewayv2_integration" "websocket" {
  api_id             = aws_apigatewayv2_api.websocket.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.platform.invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.websocket.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.websocket.id}"
}

resource "aws_apigatewayv2_stage" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  name        = "live"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 500
    throttling_rate_limit  = 200
  }
}

resource "aws_lambda_permission" "websocket" {
  statement_id  = "apigateway-websocket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.platform.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket.execution_arn}/*"
}

# Its own hostname: wss://ws.shipyard.outright.io (a WebSocket API cannot sit behind the console's CloudFront path).
resource "aws_apigatewayv2_domain_name" "websocket" {
  domain_name = var.ws_host

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.platform.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "websocket" {
  api_id      = aws_apigatewayv2_api.websocket.id
  domain_name = aws_apigatewayv2_domain_name.websocket.id
  stage       = aws_apigatewayv2_stage.websocket.id
}

resource "aws_route53_record" "ws_a" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.ws_host
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.websocket.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.websocket.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ws_aaaa" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.ws_host
  type    = "AAAA"

  alias {
    name                   = aws_apigatewayv2_domain_name.websocket.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.websocket.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
