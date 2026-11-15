# Resources owned elsewhere, consumed read-only.

data "aws_caller_identity" "current" {}

# The outright.io zone is the studio's shared infrastructure's; this root only adds records under its three hosts.
data "aws_route53_zone" "outright" {
  name         = "${local.zone_name}."
  private_zone = false
}

# The AWS-managed CloudFront policies, by name.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}
