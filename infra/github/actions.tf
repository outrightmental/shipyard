# What the Deploy workflow reads from the repository (.github/workflows/deploy.yml,
# `secrets.*`): the role it assumes through GitHub's OIDC provider, and the
# operator's address it passes to infra/.
#
# Secrets, where a private repository would use variables: neither is a
# credential (the role trusts the repository's main branch, not a key), but
# this repository and its workflow logs are public, the role's ARN carries the
# account's id and the address is a person's. A secret is masked wherever it
# appears in a log. No AWS key is stored anywhere.

resource "github_actions_secret" "deploy_role_arn" {
  repository      = github_repository.this.name
  secret_name     = "AWS_DEPLOY_ROLE_ARN"
  plaintext_value = data.terraform_remote_state.bootstrap.outputs.deploy_role_arn
}

resource "github_actions_secret" "operator_email" {
  repository      = github_repository.this.name
  secret_name     = "SHIPYARD_OPERATOR_EMAIL"
  plaintext_value = var.operator_email
}

output "actions_secrets" {
  description = "The repository's Actions secrets this root sets (their names; never their values)."
  value = [
    github_actions_secret.deploy_role_arn.secret_name,
    github_actions_secret.operator_email.secret_name,
  ]
}
