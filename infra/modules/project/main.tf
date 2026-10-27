terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    betteruptime = {
      source  = "BetterStackHQ/better-uptime"
      version = "~> 0.20"
    }
    onepassword = {
      source  = "1Password/onepassword"
      version = "~> 2.0"
    }
  }
}

locals {
  # One entry per environment and domain, with the Cloudflare zone the domain belongs to.
  dns_records = merge([
    for env, settings in var.environments : {
      for domain in settings.domains : domain => {
        ip   = settings.host_ip
        zone = one([for zone, id in var.cloudflare_zones : id if domain == zone || endswith(domain, ".${zone}")])
      }
    }
  ]...)
}

# A bucket per environment for the Litestream backups (and uploads, under their own prefix),
# with a user that can reach that bucket only.
resource "upcloud_managed_object_storage_bucket" "this" {
  for_each     = var.environments
  service_uuid = var.object_storage.service_uuid
  name         = "${var.name}-${each.key}"
}

resource "upcloud_managed_object_storage_user" "this" {
  for_each     = var.environments
  service_uuid = var.object_storage.service_uuid
  username     = "${var.name}-${each.key}"
}

resource "upcloud_managed_object_storage_user_access_key" "this" {
  for_each     = var.environments
  service_uuid = var.object_storage.service_uuid
  username     = upcloud_managed_object_storage_user.this[each.key].username
  status       = "Active"
}

resource "upcloud_managed_object_storage_policy" "this" {
  for_each     = var.environments
  service_uuid = var.object_storage.service_uuid
  name         = "${var.name}-${each.key}"
  document = urlencode(jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["s3:*"]
      Resource = [
        "arn:aws:s3:::${upcloud_managed_object_storage_bucket.this[each.key].name}",
        "arn:aws:s3:::${upcloud_managed_object_storage_bucket.this[each.key].name}/*",
      ]
    }]
  }))
}

resource "upcloud_managed_object_storage_user_policy" "this" {
  for_each     = var.environments
  service_uuid = var.object_storage.service_uuid
  username     = upcloud_managed_object_storage_user.this[each.key].username
  name         = upcloud_managed_object_storage_policy.this[each.key].name
}

# The keys go straight to 1Password, in an item of their own, so the deploy workflow reads
# them like any other secret and nobody copies them by hand.
resource "onepassword_item" "infra" {
  for_each = var.environments
  vault    = var.onepassword_vault_id
  title    = "${var.name}-${each.key}-infra"
  category = "secure_note"

  section {
    label = "lautta"

    dynamic "field" {
      for_each = {
        LITESTREAM_BUCKET            = upcloud_managed_object_storage_bucket.this[each.key].name
        LITESTREAM_ENDPOINT          = var.object_storage.endpoint
        LITESTREAM_ACCESS_KEY_ID     = upcloud_managed_object_storage_user_access_key.this[each.key].access_key_id
        LITESTREAM_SECRET_ACCESS_KEY = upcloud_managed_object_storage_user_access_key.this[each.key].secret_access_key
        S3_BUCKET                    = upcloud_managed_object_storage_bucket.this[each.key].name
        S3_ENDPOINT                  = var.object_storage.endpoint
        S3_REGION                    = var.object_storage.region
        S3_ACCESS_KEY_ID             = upcloud_managed_object_storage_user_access_key.this[each.key].access_key_id
        S3_SECRET_ACCESS_KEY         = upcloud_managed_object_storage_user_access_key.this[each.key].secret_access_key
      }
      content {
        label = field.key
        type  = "CONCEALED"
        value = field.value
      }
    }
  }
}

resource "cloudflare_dns_record" "this" {
  for_each = { for domain, record in local.dns_records : domain => record if record.zone != null }
  zone_id  = each.value.zone
  name     = each.key
  type     = "A"
  content  = each.value.ip
  ttl      = 1
  # DNS only: kamal-proxy gets its own Let's Encrypt certificates over plain HTTP.
  proxied = false
}

resource "betteruptime_monitor" "this" {
  for_each           = toset([for path in var.uptime_paths : "https://${var.environments.production.domains[0]}${path}"])
  url                = each.key
  monitor_type       = "status"
  check_frequency    = 60
  pronounceable_name = "${var.name} ${each.key}"
  ssl_expiration     = 14
  email              = false
}
