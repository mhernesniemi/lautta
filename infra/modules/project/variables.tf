variable "name" {
  description = "The project's service name, as in its config/deploy.yml"
  type        = string
}

variable "environments" {
  description = "Server IP and domains per environment; production is required"
  type = map(object({
    host_ip = string
    domains = list(string)
  }))

  validation {
    condition     = contains(keys(var.environments), "production")
    error_message = "environments must include production."
  }
}

variable "object_storage" {
  description = "The shared UpCloud Managed Object Storage instance"
  type = object({
    service_uuid = string
    endpoint     = string
    region       = string
  })
}

variable "onepassword_vault_id" {
  description = "UUID of the client's 1Password vault"
  type        = string
}

variable "cloudflare_zones" {
  description = "Our Cloudflare zones, name → zone id; domains outside them get no DNS record"
  type        = map(string)
  default     = {}
}

variable "uptime_paths" {
  description = "Paths on the first production domain that Better Stack checks, e.g. the health check"
  type        = list(string)
  default     = []
}
