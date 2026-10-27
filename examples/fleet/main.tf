# The fleet: servers, storage and projects from fleet.yml. Copy this folder into a private
# repo; `tofu apply` there creates or changes everything. Credentials come from the
# environment: UPCLOUD_TOKEN, CLOUDFLARE_API_TOKEN, BETTERUPTIME_API_TOKEN,
# OP_SERVICE_ACCOUNT_TOKEN, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (state bucket) and
# TF_VAR_state_passphrase.

terraform {
  required_version = ">= 1.8"

  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
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

  # State in UpCloud Object Storage (create this bucket by hand once), encrypted before it leaves
  # this machine: it holds storage keys and the servers' SSH host keys.
  backend "s3" {
    bucket                      = "lautta-state"
    key                         = "fleet.tfstate"
    region                      = "europe-1"
    endpoints                   = { s3 = "https://replace-me.upcloudobjects.com" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  description = "Encrypts the state; kept in 1Password"
  type        = string
  sensitive   = true
}

variable "collector_command" {
  description = "Command that installs Better Stack's collector on a new server (empty: none)"
  type        = string
  default     = ""
  sensitive   = true
}

locals {
  fleet = yamldecode(file("${path.module}/fleet.yml"))
}

resource "upcloud_managed_object_storage" "this" {
  name              = "lautta"
  region            = local.fleet.object_storage_region
  configured_status = "started"

  network {
    family = "IPv4"
    name   = "public"
    type   = "public"
  }
}

locals {
  object_storage = {
    service_uuid = upcloud_managed_object_storage.this.id
    region       = local.fleet.object_storage_region
    endpoint = one([
      for endpoint in upcloud_managed_object_storage.this.endpoint :
      "https://${endpoint.domain_name}" if endpoint.type == "public"
    ])
  }
}

resource "betteruptime_heartbeat" "host" {
  for_each = local.fleet.hosts
  name     = "${each.key} host-check"
  period   = 300
  grace    = 300
  email    = false
}

module "host" {
  source   = "github.com/mhernesniemi/lautta//infra/modules/host?ref=v1"
  for_each = local.fleet.hosts

  name              = each.key
  zone              = each.value.zone
  plan              = each.value.plan
  ssh_keys          = local.fleet.ssh_keys
  heartbeat_url     = betteruptime_heartbeat.host[each.key].url
  collector_command = var.collector_command
}

# The deploy workflow trusts exactly these servers.
resource "onepassword_item" "known_hosts" {
  vault      = local.fleet.ops_vault
  title      = "known-hosts"
  category   = "secure_note"
  note_value = join("\n", [for host in module.host : host.known_hosts])
}

module "project" {
  source   = "github.com/mhernesniemi/lautta//infra/modules/project?ref=v1"
  for_each = local.fleet.projects

  name                 = each.key
  onepassword_vault_id = each.value.vault
  object_storage       = local.object_storage
  cloudflare_zones     = local.fleet.cloudflare_zones
  uptime_paths         = try(each.value.uptime_paths, [])
  environments = {
    for env in ["production", "staging"] : env => {
      host_ip = module.host[each.value[env].host].ip
      domains = each.value[env].domains
    } if can(each.value[env])
  }
}

output "hosts" {
  value = { for name, host in module.host : name => host.ip }
}
