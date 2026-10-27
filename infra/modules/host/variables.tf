variable "name" {
  description = "Hostname, e.g. prod-1"
  type        = string
}

variable "zone" {
  description = "UpCloud zone, e.g. fi-hel1"
  type        = string
}

variable "plan" {
  description = "UpCloud plan, e.g. 4xCPU-8GB"
  type        = string
}

variable "storage_size" {
  description = "Disk size in GB"
  type        = number
  default     = 80
}

variable "ssh_keys" {
  description = "Public SSH keys allowed to log in as the deploy user: the team's and the deploy key"
  type        = list(string)
}

variable "heartbeat_url" {
  description = "Better Stack heartbeat that host-check pings every 5 minutes (empty: no host-check)"
  type        = string
  default     = ""
}

variable "collector_command" {
  description = "Shell command that installs Better Stack's collector (empty: none)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "labels" {
  description = "UpCloud labels, e.g. { role = \"shared\" }"
  type        = map(string)
  default     = {}
}
