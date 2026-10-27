locals {
  ip = one([
    for nic in upcloud_server.this.network_interface : nic.ip_address
    if nic.type == "public" && nic.ip_address_family == "IPv4"
  ])
}

output "ip" {
  description = "Public IPv4 address"
  value       = local.ip
}

output "known_hosts" {
  description = "known_hosts line for this server"
  value       = "${local.ip} ${trimspace(tls_private_key.host.public_key_openssh)}"
}
