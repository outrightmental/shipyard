locals {
  aws_region     = "us-east-1"
  aws_account_id = data.aws_caller_identity.current.account_id

  # The one name everything is called: the table, the function, the APIs, the log groups, the pool.
  name = "shipyard"

  table_name     = "shipyard-platform"
  console_bucket = "shipyard-console-${local.aws_account_id}"
  schedule_group = "shipyard"
  # The GitHub App's credentials (its private key, webhook secret and client
  # secret), written by the function when the operator connects GitHub in the
  # console. Never in the table, never in this state.
  ssm_prefix = "/shipyard/"

  zone_name = "outright.io"

  # The repository that deploys this root (bootstrap/).
  github_repo = "outrightmental/shipyard"

  tags = {
    Project     = "Shipyard"
    Environment = "production"
    ManagedBy   = "terraform"
    Repo        = local.github_repo
  }
}
