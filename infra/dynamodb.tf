# The one table (src/platform/store.ts), single-table layout:
#
#   PK            SK                  what
#   CONFIG        github              the GitHub App Shipyard connects as (its ids; never its secrets)
#   REPO          <owner/repo>        a subscribed repository, and the fleet member it is assigned to
#   MEMBER        <memberId>          a fleet member: its name, pool size, token hash, last heartbeat
#   ENROLL        <sha256 of code>    a one-time enrollment code (ttl: fifteen minutes)
#   CONN          <connectionId>      an open WebSocket: a console's or a fleet member's (ttl)
#   CACHE#<id>    <cache key>         a fleet member's replayable events: what a console opened
#                                     now is brought up to date with (src/shared/replay-cache.ts)
#
# TTL on `ttl` (spent codes and stale connection rows leave by themselves),
# point-in-time recovery as a floor under an accident.
resource "aws_dynamodb_table" "platform" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
