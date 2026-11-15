# The platform function: one Lambda for every event (src/platform/handler.ts).
#
# THE BUNDLE IS BUILT BEFORE THE APPLY. `npm run build:lambda`
# (tools/build-lambda.mjs) bundles src/platform/ into
# infra/.build/lambda/index.mjs with esbuild — one file and its source map,
# with the AWS SDK left out, since the Node.js runtime carries it — and
# archive_file zips it here. It is small enough to upload directly.

data "archive_file" "platform" {
  type        = "zip"
  source_dir  = "${path.module}/.build/lambda"
  output_path = "${path.module}/.build/platform.zip"
}

# --- Role ------------------------------------------------------------------

data "aws_iam_policy_document" "platform_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "platform" {
  name               = "${local.name}-platform"
  assume_role_policy = data.aws_iam_policy_document.platform_assume.json
}

data "aws_iam_policy_document" "platform" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.platform.arn}:*"]
  }

  statement {
    sid = "Table"
    actions = [
      "dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.platform.arn, "${aws_dynamodb_table.platform.arn}/index/*"]
  }

  # The consoles' and the fleet members' connections.
  statement {
    sid       = "ManageConnections"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.websocket.execution_arn}/*"]
  }

  # The GitHub App's credentials: written once, when the operator connects
  # GitHub in the console, and read to sign the app's requests.
  statement {
    sid       = "Secrets"
    actions   = ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"]
    resources = ["arn:aws:ssm:${local.aws_region}:${local.aws_account_id}:parameter${local.ssm_prefix}*"]
  }
}

resource "aws_iam_role_policy" "platform" {
  name   = "${local.name}-platform"
  role   = aws_iam_role.platform.id
  policy = data.aws_iam_policy_document.platform.json
}

# --- Function --------------------------------------------------------------

resource "aws_cloudwatch_log_group" "platform" {
  name              = "/aws/lambda/${local.name}-platform"
  retention_in_days = 30
}

resource "aws_lambda_function" "platform" {
  function_name = "${local.name}-platform"
  role          = aws_iam_role.platform.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  filename      = data.archive_file.platform.output_path
  # The archive's hash, so a changed source redeploys and an unchanged one does not.
  source_code_hash = data.archive_file.platform.output_base64sha256

  memory_size = 512
  timeout     = 60

  environment {
    variables = {
      SHIPYARD_TABLE             = aws_dynamodb_table.platform.name
      SHIPYARD_WS_ENDPOINT       = "https://${aws_apigatewayv2_api.websocket.id}.execute-api.${local.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.websocket.name}"
      SHIPYARD_SSM_PREFIX        = local.ssm_prefix
      SHIPYARD_COGNITO_ISSUER    = "https://cognito-idp.${local.aws_region}.amazonaws.com/${aws_cognito_user_pool.console.id}"
      SHIPYARD_COGNITO_CLIENT_ID = aws_cognito_user_pool_client.console.id
      SHIPYARD_PUBLIC_URL        = "https://${var.console_host}"
      SHIPYARD_PUBLIC_WS         = "wss://${var.ws_host}"
      SHIPYARD_RELEASE_SHA       = var.release_sha
      NODE_OPTIONS               = "--enable-source-maps"
    }
  }

  depends_on = [aws_cloudwatch_log_group.platform]
}

# The deploy's announcement: once the function runs this commit, it tells
# every connected fleet member (src/platform/fleet.ts announceRelease), so a
# machine on another commit updates itself now rather than at its next
# heartbeat. Invoked again whenever the release or the code changes; the
# function answers without failing even when no member is connected.
resource "aws_lambda_invocation" "announce_release" {
  function_name = aws_lambda_function.platform.function_name
  input         = jsonencode({ source = "shipyard.release" })

  triggers = {
    release = var.release_sha
    code    = data.archive_file.platform.output_base64sha256
  }
}
