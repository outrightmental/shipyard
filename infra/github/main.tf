# Shipyard — the GitHub repository itself, as code.
#
# The repository's settings are IMPORTED here (repository.tf): visibility,
# features, the merge buttons, what GitHub Actions may do in it. What this root
# ADDS is what the Deploy workflow (.github/workflows/deploy.yml) needs to run:
# the repository's Actions secrets (actions.tf) — the deploy role's ARN, read
# from the bootstrap root's state, and the operator's address — so a deploy
# never depends on a value someone typed into GitHub's settings. A
# `terraform plan` here shows any drift a click in GitHub's settings has made
# since.
#
# A ROOT OF ITS OWN, APPLIED BY HAND, like infra/bootstrap/. The Deploy
# workflow applies infra/ as the deploy role, which has no GitHub credential
# (a workflow's own GITHUB_TOKEN cannot be granted Administration), so a GitHub
# provider in that root would fail every deploy at plan. Here it is planned and
# applied by a person, with a token from the GitHub CLI:
#
#   export GITHUB_TOKEN=$(gh auth token)        # PowerShell: $env:GITHUB_TOKEN = (gh auth token)
#   terraform -chdir=infra/github init
#   terraform -chdir=infra/github apply -var operator_email=<you>
#
# The token needs `repo` scope and admin on the repository; it is read from the
# environment and never committed or written to state. The AWS credentials are
# for the state bucket alone (this root's state, and the bootstrap root's outputs).

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.6"
    }
  }

  backend "s3" {
    bucket       = "outrightmental-terraform-state"
    key          = "shipyard-github"
    region       = "us-east-1"
    use_lockfile = true
  }
}

provider "github" {
  owner = "outrightmental"
}

variable "operator_email" {
  description = "The operator who signs in to the console: the Deploy workflow passes it to infra/ as the Cognito account. This repository is public, so it has no default here and is kept as an Actions secret, which GitHub masks in the workflow's log."
  type        = string
  nullable    = false
  sensitive   = true
}

locals {
  # The repository's name, exactly as GitHub spells it.
  repository = "shipyard"
}

# The deploy role the bootstrap root created: its ARN is what the workflow assumes.
data "terraform_remote_state" "bootstrap" {
  backend = "s3"
  config = {
    bucket       = "outrightmental-terraform-state"
    key          = "shipyard-bootstrap"
    region       = "us-east-1"
    use_lockfile = true
  }
}
