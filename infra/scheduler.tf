# EventBridge Scheduler: the platform's one schedule, the tick. Every two
# minutes the function clears connection rows whose socket is gone and
# refreshes its own reading of the repositories no fleet member is assigned
# (src/platform/tick.ts): their issues are on the dashboard as waiting work
# even though no machine is reading them.
resource "aws_scheduler_schedule_group" "platform" {
  name = local.schedule_group
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.aws_account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.platform.arn, "${aws_lambda_function.platform.arn}:*"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.name}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "tick" {
  name        = "${local.name}-tick"
  group_name  = aws_scheduler_schedule_group.platform.name
  description = "Every two minutes: stale connections are cleared, and the unassigned repositories' work is read again."

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = "rate(2 minutes)"

  target {
    arn      = aws_lambda_function.platform.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source = "shipyard.tick" })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
