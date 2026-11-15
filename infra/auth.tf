# The sign-in host: https://auth.shipyard.outright.io, the console's own
# sign-in pages, custom-hosted in place of Cognito's: console/auth/, plain
# files in the console's bucket under auth/, behind a CloudFront distribution
# of their own. They sign in against the user pool with Cognito's API
# (cognito.tf's client takes the password flow) and hand the tokens back to
# the console; the pool has no domain, so Cognito hosts no page of it anywhere.
#
# config.json, written here, names the pool's region and client, the console
# URLs the pages may hand tokens to, the pool's password policy, and how many
# days the pages remember a sign-in: as long as the client's refresh token
# lives. Every file is no-cache, so a deploy is live at once.

resource "aws_acm_certificate" "auth" {
  domain_name       = var.auth_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "auth_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.auth.domain_validation_options :
    dvo.domain_name => { name = dvo.resource_record_name, type = dvo.resource_record_type, record = dvo.resource_record_value }
  }

  zone_id         = data.aws_route53_zone.outright.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "auth" {
  certificate_arn         = aws_acm_certificate.auth.arn
  validation_record_fqdns = [for r in aws_route53_record.auth_cert_validation : r.fqdn]
}

# --- The pages and their config --------------------------------------------

locals {
  auth_pages = "${path.module}/../console/auth"
  # The pages' own files (not a local config.json: the one below is theirs), and the console's icon
  # beside them (the pages link /favicon.svg).
  auth_files = merge(
    { for f in fileset(local.auth_pages, "*") : f => "${local.auth_pages}/${f}" if f != "config.json" },
    { for f in ["favicon.svg"] : f => "${path.module}/../console/public/${f}" },
  )
  auth_config = {
    region       = local.aws_region
    clientId     = aws_cognito_user_pool_client.console.id
    redirectUris = ["https://${var.console_host}/"]
    # In days: cognito.tf's token_validity_units.refresh_token.
    rememberDays = aws_cognito_user_pool_client.console.refresh_token_validity
    passwordPolicy = {
      minimumLength    = aws_cognito_user_pool.console.password_policy[0].minimum_length
      requireLowercase = aws_cognito_user_pool.console.password_policy[0].require_lowercase
      requireUppercase = aws_cognito_user_pool.console.password_policy[0].require_uppercase
      requireNumbers   = aws_cognito_user_pool.console.password_policy[0].require_numbers
      requireSymbols   = aws_cognito_user_pool.console.password_policy[0].require_symbols
    }
  }
}

resource "aws_s3_object" "auth" {
  for_each = local.auth_files

  bucket        = aws_s3_bucket.console.id
  key           = "auth/${each.key}"
  source        = each.value
  etag          = filemd5(each.value)
  content_type  = lookup(local.content_types, lower(element(split(".", each.key), length(split(".", each.key)) - 1)), "application/octet-stream")
  cache_control = "no-cache"
}

resource "aws_s3_object" "auth_config" {
  bucket        = aws_s3_bucket.console.id
  key           = "auth/config.json"
  content       = jsonencode(local.auth_config)
  content_type  = "application/json"
  cache_control = "no-cache"
  etag          = md5(jsonencode(local.auth_config))
}

# --- The distribution ------------------------------------------------------

# The console's security headers, and a Content-Security-Policy that lets the pages load only their
# own files and call only Cognito's API: no inline script or style, no frame, no other origin.
resource "aws_cloudfront_response_headers_policy" "auth" {
  name = "${local.name}-auth-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "connect-src 'self' https://cognito-idp.${local.aws_region}.amazonaws.com",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ])
      override = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "auth" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = var.auth_host
  http_version        = "http2and3"
  aliases             = [var.auth_host]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "auth"
    origin_path              = "/auth"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }

  # /logout (and any path without a file extension) is the page itself, as the console's routes are.
  default_cache_behavior {
    target_origin_id           = "auth"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.auth.id
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.auth.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "auth" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.auth_host
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.auth.domain_name
    zone_id                = aws_cloudfront_distribution.auth.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "auth_aaaa" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.auth_host
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.auth.domain_name
    zone_id                = aws_cloudfront_distribution.auth.hosted_zone_id
    evaluate_target_health = false
  }
}
