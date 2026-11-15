# Shipyard — the trust: who may deploy the platform from GitHub Actions.
#
# The stack (../) is applied by the Deploy workflow (.github/workflows/deploy.yml)
# on every push to main, as the role `shipyard-deploy` this root creates,
# through the account's one GitHub OIDC provider (owned by the studio's shared
# infrastructure, read here). This root is applied BY A PERSON, with an
# administrator's credentials, once, and again only when the trust changes —
# the studio's two-roots design: the thing a role trusts must not be the thing
# that writes the trust.
#
#   terraform -chdir=infra/bootstrap init
#   terraform -chdir=infra/bootstrap apply
#
# The role's reach is the platform's own names (../locals.tf): the table, the
# function, the APIs, the pool, the schedule group, the console bucket and its
# distributions, the state key. It may not change IAM beyond the platform's
# roles, and never itself.
#
# This repository is public, so the account is not written down here: it is
# whichever account the credentials are for.

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket       = "outrightmental-terraform-state"
    key          = "shipyard-bootstrap"
    region       = "us-east-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = local.aws_region
}

locals {
  aws_region     = "us-east-1"
  aws_account_id = data.aws_caller_identity.current.account_id
  github_repo    = "outrightmental/shipyard"
  deploy_branch  = "main"
  name           = "shipyard"
  state_key      = "shipyard"
  role_name      = "shipyard-deploy"
  regional       = "${local.aws_region}:${local.aws_account_id}"

  # The subject GitHub's OIDC token names for this repository. A repository
  # created since GitHub made subjects immutable is named with its owner's and
  # its own numeric ids, so a repository renamed, or deleted and made again
  # under the same name, is not this one:
  #
  #   gh api repos/outrightmental/shipyard/actions/oidc/customization/sub
  #
  # (`sub_claim_prefix`; `use_immutable_subject` is true.) The role trusts
  # main, and only main, of that repository.
  oidc_subject_prefix = "repo:outrightmental@503741/shipyard@1458626024"
}

data "aws_caller_identity" "current" {}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_route53_zone" "outright" {
  name         = "outright.io."
  private_zone = false
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${local.oidc_subject_prefix}:ref:refs/heads/${local.deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = local.role_name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 3600
  description          = "GitHub Actions on main of ${local.github_repo}: terraform apply of infra/"
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "StateBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::outrightmental-terraform-state"]
  }
  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::outrightmental-terraform-state/${local.state_key}", "arn:aws:s3:::outrightmental-terraform-state/${local.state_key}.tflock"]
  }
  statement {
    sid     = "Buckets"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.name}-console-${local.aws_account_id}", "arn:aws:s3:::${local.name}-console-${local.aws_account_id}/*",
    ]
  }
  statement {
    sid       = "Table"
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:${local.regional}:table/${local.name}-platform", "arn:aws:dynamodb:${local.regional}:table/${local.name}-platform/*"]
  }
  statement {
    sid       = "Function"
    actions   = ["lambda:*"]
    resources = ["arn:aws:lambda:${local.regional}:function:${local.name}-platform", "arn:aws:lambda:${local.regional}:function:${local.name}-platform:*"]
  }
  statement {
    sid       = "Roles"
    actions   = ["iam:*Role*", "iam:ListInstanceProfilesForRole", "iam:PassRole"]
    resources = ["arn:aws:iam::${local.aws_account_id}:role/${local.name}-*"]
  }
  statement {
    sid       = "NotItself"
    effect    = "Deny"
    actions   = ["iam:*"]
    resources = ["arn:aws:iam::${local.aws_account_id}:role/${local.role_name}"]
  }
  statement {
    sid     = "Logs"
    actions = ["logs:*"]
    resources = [
      "arn:aws:logs:${local.regional}:log-group:/aws/lambda/${local.name}-*", "arn:aws:logs:${local.regional}:log-group:/aws/lambda/${local.name}-*:*",
      "arn:aws:logs:${local.regional}:log-group:/aws/apigateway/${local.name}-*", "arn:aws:logs:${local.regional}:log-group:/aws/apigateway/${local.name}-*:*",
    ]
  }
  # API Gateway delivers its access log through a log delivery, which names no log group.
  statement {
    sid = "LogsDescribe"
    actions = [
      "logs:DescribeLogGroups", "logs:DescribeResourcePolicies", "logs:PutResourcePolicy", "logs:ListLogDeliveries",
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "Schedules"
    actions   = ["scheduler:*"]
    resources = ["arn:aws:scheduler:${local.regional}:schedule/${local.name}/*", "arn:aws:scheduler:${local.regional}:schedule-group/${local.name}"]
  }
  statement {
    sid       = "Cognito"
    actions   = ["cognito-idp:*"]
    resources = ["*"] # a pool's id is assigned by the service
  }
  statement {
    sid       = "ApiGateway"
    actions   = ["apigateway:*"]
    resources = ["arn:aws:apigateway:${local.aws_region}::/*"]
  }
  statement {
    sid       = "CloudFrontAndAcm"
    actions   = ["cloudfront:*", "acm:*"]
    resources = ["*"] # ids are assigned by the service
  }
  statement {
    sid       = "ZoneRecords"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone", "route53:ListTagsForResource"]
    resources = [data.aws_route53_zone.outright.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["shipyard.outright.io", "*.shipyard.outright.io"]
    }
  }
  statement {
    sid       = "Route53Read"
    actions   = ["route53:ListHostedZones", "route53:ListHostedZonesByName", "route53:GetChange"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadAccount"
    actions   = ["sts:GetCallerIdentity", "iam:GetOpenIDConnectProvider"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = local.role_name
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  description = "The repository's Actions secret AWS_DEPLOY_ROLE_ARN, set by infra/github from this state."
  value       = aws_iam_role.deploy.arn
}
