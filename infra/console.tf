# The console at https://shipyard.outright.io: the static build in a private
# bucket behind CloudFront, the API proxied on the same origin (no CORS, the
# bearer token forwarded), everything else the single-page app (a path with no
# file extension is index.html). config.json is written here from the pool,
# the client and the hosts, never bundled.
#
# THE CONSOLE IS BUILT BEFORE THE APPLY: `npm run build:console`
# (tools/build-console.mjs) writes dist/console/.

# --- Certificate: the console host and the WebSocket host ------------------

resource "aws_acm_certificate" "platform" {
  domain_name               = var.console_host
  subject_alternative_names = [var.ws_host]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.platform.domain_validation_options :
    dvo.domain_name => { name = dvo.resource_record_name, type = dvo.resource_record_type, record = dvo.resource_record_value }
  }
  zone_id         = data.aws_route53_zone.outright.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "platform" {
  certificate_arn         = aws_acm_certificate.platform.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --- The bucket and its files ----------------------------------------------

resource "aws_s3_bucket" "console" {
  bucket = local.console_bucket
}

resource "aws_s3_bucket_public_access_block" "console" {
  bucket                  = aws_s3_bucket.console.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "console" {
  name                              = "${local.name}-console"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "console_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.console.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      # The console's distribution, and the sign-in pages' (auth.tf), which read the bucket's auth/.
      values = [aws_cloudfront_distribution.console.arn, aws_cloudfront_distribution.auth.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "console" {
  bucket = aws_s3_bucket.console.id
  policy = data.aws_iam_policy_document.console_bucket.json
}

locals {
  console_dist  = "${path.module}/../dist/console"
  console_files = fileset(local.console_dist, "**")
  content_types = {
    html = "text/html; charset=utf-8", js = "text/javascript; charset=utf-8", mjs = "text/javascript; charset=utf-8", css = "text/css; charset=utf-8",
    json = "application/json", svg = "image/svg+xml", png = "image/png", ico = "image/x-icon", woff2 = "font/woff2", woff = "font/woff", map = "application/json",
    txt  = "text/plain", webmanifest = "application/manifest+json", webm = "video/webm", mp4 = "video/mp4",
  }
  console_config = {
    apiBase = "/api"
    wsUrl   = "wss://${var.ws_host}"
    cognito = {
      domain      = "https://${var.auth_host}"
      clientId    = aws_cognito_user_pool_client.console.id
      redirectUri = "https://${var.console_host}/"
      userPoolId  = aws_cognito_user_pool.console.id
      region      = local.aws_region
    }
    release = var.release_sha
  }
}

resource "aws_s3_object" "console" {
  for_each = local.console_files

  bucket       = aws_s3_bucket.console.id
  key          = each.value
  source       = "${local.console_dist}/${each.value}"
  etag         = filemd5("${local.console_dist}/${each.value}")
  content_type = lookup(local.content_types, lower(element(split(".", each.value), length(split(".", each.value)) - 1)), "application/octet-stream")
  # Hashed assets forever, the entry page and the config never.
  cache_control = can(regex("^assets/", each.value)) ? "public, max-age=31536000, immutable" : "no-cache"
}

resource "aws_s3_object" "console_config" {
  bucket        = aws_s3_bucket.console.id
  key           = "config.json"
  content       = jsonencode(local.console_config)
  content_type  = "application/json"
  cache_control = "no-cache"
  etag          = md5(jsonencode(local.console_config))
}

# --- The distribution ------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "console" {
  name = "${local.name}-console-security"

  security_headers_config {
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

locals {
  api_origin_domain = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
  # Everything the function answers, on the console's origin: never cached,
  # every viewer header but Host forwarded (the bearer token among them).
  api_paths = ["/api/*", "/fleet/*", "/enroll*", "/hooks/*", "/healthz"]
}

# The single-page app's routing, on the static origin only: a path with no file extension is the
# app's (served as index.html); a file is itself. The API behaviors never see this function, so a
# 404 from the platform stays a 404 to its caller (the console's fetches, a fleet member).
resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-console-spa"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for app routes; files as themselves"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri === '/' || uri.indexOf('.') !== -1) { return request; }
      request.uri = '/index.html';
      return request;
    }
  EOT
}

resource "aws_cloudfront_distribution" "console" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = var.console_host
  http_version        = "http2and3"
  aliases             = [var.console_host]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "console"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }

  origin {
    domain_name = local.api_origin_domain
    origin_id   = "api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # The app: cached hard (hashed assets), the entry page and config.json say no-cache themselves.
  default_cache_behavior {
    target_origin_id           = "console"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.console.id
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.api_paths
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = "api"
      viewer_protocol_policy     = "https-only"
      allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods             = ["GET", "HEAD"]
      cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.console.id
      compress                   = true
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.platform.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "console_a" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.console_host
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.console.domain_name
    zone_id                = aws_cloudfront_distribution.console.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "console_aaaa" {
  zone_id = data.aws_route53_zone.outright.zone_id
  name    = var.console_host
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.console.domain_name
    zone_id                = aws_cloudfront_distribution.console.hosted_zone_id
    evaluate_target_health = false
  }
}
