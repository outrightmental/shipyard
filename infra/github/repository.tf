# The repository and how GitHub Actions behaves in it, every value as it was
# when this root adopted them on 2026-11-15 — but for issues, which were off
# and are on: Shipyard's own work is planned as issues, like every repository
# it builds. The `import` blocks are what make the first apply adopt the
# existing repository rather than try to create a second one by the same name;
# once in state they are no-ops.
#
# Not managed here, on purpose: the OIDC subject (the deploy role's trust in
# infra/bootstrap/ lists the subject GitHub sends), and people, who have access
# as owners of the organisation.

import {
  to = github_repository.this
  id = local.repository
}

resource "github_repository" "this" {
  name        = local.repository
  description = "distributed agentic coding factory, centralized for the whole organization"
  visibility  = "public"

  has_issues      = true
  has_discussions = false
  has_projects    = true
  has_wiki        = false
  is_template     = false
  allow_forking   = true

  allow_merge_commit          = true
  allow_rebase_merge          = true
  allow_squash_merge          = true
  allow_auto_merge            = false
  allow_update_branch         = false
  delete_branch_on_merge      = false
  squash_merge_commit_title   = "COMMIT_OR_PR_TITLE"
  squash_merge_commit_message = "COMMIT_MESSAGES"
  merge_commit_title          = "MERGE_MESSAGE"
  merge_commit_message        = "PR_TITLE"

  web_commit_signoff_required = false
  vulnerability_alerts        = true

  # `terraform destroy` archives the repository instead of deleting it.
  archive_on_destroy = true

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = github_branch_default.this
  id = local.repository
}

resource "github_branch_default" "this" {
  repository = github_repository.this.name
  branch     = "main"
}

# Actions on, any action allowed, and the workflows' own GITHUB_TOKEN as GitHub
# defaulted it for this repository. The workflows narrow it themselves with a
# `permissions:` block where they need to (deploy.yml: contents read, id-token write).
import {
  to = github_actions_repository_permissions.this
  id = local.repository
}

resource "github_actions_repository_permissions" "this" {
  repository      = github_repository.this.name
  enabled         = true
  allowed_actions = "all"
}

import {
  to = github_workflow_repository_permissions.this
  id = local.repository
}

resource "github_workflow_repository_permissions" "this" {
  repository                       = github_repository.this.name
  default_workflow_permissions     = "write"
  can_approve_pull_request_reviews = true
}
