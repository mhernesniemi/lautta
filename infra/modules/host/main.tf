terraform {
  required_providers {
    upcloud = {
      source  = "UpCloudLtd/upcloud"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

# The server's SSH host key, made here so known_hosts is known before the server boots.
resource "tls_private_key" "host" {
  algorithm = "ED25519"
}

resource "upcloud_server" "this" {
  hostname = var.name
  zone     = var.zone
  plan     = var.plan
  metadata = true
  labels   = merge(var.labels, { managed-by = "lautta" })

  template {
    storage = "Ubuntu Server 24.04 LTS (Noble Numbat)"
    size    = var.storage_size
  }

  network_interface {
    type = "public"
  }

  network_interface {
    type = "utility"
  }

  login {
    keys            = var.ssh_keys
    create_password = false
  }

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    hostname          = var.name
    ssh_keys          = var.ssh_keys
    host_key_private  = tls_private_key.host.private_key_openssh
    host_key_public   = trimspace(tls_private_key.host.public_key_openssh)
    host_check        = filebase64("${path.module}/host-check.sh")
    heartbeat_url     = var.heartbeat_url
    collector_command = var.collector_command
  })

  # cloud-init runs once, at the first boot. Changing it later must not replace the server.
  lifecycle {
    ignore_changes = [user_data, login]
  }
}
