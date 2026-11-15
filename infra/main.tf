# Shipyard as one serverless platform (#1).
#
# One Terraform root owns the whole platform, and never a repository or a
# machine: subscribing to a repository and enrolling a fleet member are console
# actions (rows in the table). What is here:
#
#   - The table: one DynamoDB table, on demand, single-table layout, with TTL
#     and point-in-time recovery (dynamodb.tf).
#   - The function: one Lambda for every event the platform receives — the
#     console's HTTP API, the fleet's HTTP API, the WebSocket API, the schedule
#     (lambda.tf).
#   - The HTTP API with a Cognito JWT authorizer on /api/*, and the WebSocket
#     API with its own hostname (api.tf, websocket.tf); the user pool and the
#     operator's account (cognito.tf); the console's own sign-in pages at the
#     sign-in host (auth.tf).
#   - The console: the static build in S3 behind CloudFront at the console
#     host, the API proxied on the same origin (console.tf).
#   - The one schedule: the tick that keeps the platform's own view of
#     unassigned repositories fresh and clears stale connections (scheduler.tf).
#
# There is no staging: main is production. The Deploy workflow
# (.github/workflows/deploy.yml) applies this root on every push to main, as
# the role infra/bootstrap/ creates. Apply it from a laptop with an
# administrator's credentials the first time (the function and the console are
# built before the apply):
#
#   npm ci && npm run build:lambda && npm run build:console
#   terraform -chdir=infra init
#   terraform -chdir=infra apply -var operator_email=<you>

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # The studio's shared state bucket, under this project's own key, with S3-native locking.
  backend "s3" {
    bucket       = "outrightmental-terraform-state"
    key          = "shipyard"
    region       = "us-east-1"
    use_lockfile = true
  }
}

# us-east-1 throughout: CloudFront's certificate must be here, and so is everything else of the studio's.
provider "aws" {
  region = local.aws_region

  default_tags {
    tags = local.tags
  }
}

variable "operator_email" {
  description = "The operator who signs in to the console; their Cognito account is created with an invitation. Never committed: this repository is public, so the Deploy workflow passes it from an Actions secret."
  type        = string
  nullable    = false
  sensitive   = true
}

variable "console_host" {
  description = "The console's hostname, in the outright.io zone."
  type        = string
  default     = "shipyard.outright.io"
}

variable "ws_host" {
  description = "The WebSocket API's hostname, in the outright.io zone."
  type        = string
  default     = "ws.shipyard.outright.io"
}

variable "auth_host" {
  description = "The sign-in hostname (the console's own sign-in pages, auth.tf), in the outright.io zone, under the console host."
  type        = string
  default     = "auth.shipyard.outright.io"
}

variable "release_sha" {
  description = "The commit this deploy carries, stamped into the function's environment (the deploy workflow sets it). Fleet members bring themselves to it."
  type        = string
  default     = "local"
}
