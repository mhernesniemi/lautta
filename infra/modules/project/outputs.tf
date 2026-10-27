output "buckets" {
  description = "Bucket name per environment"
  value       = { for env, bucket in upcloud_managed_object_storage_bucket.this : env => bucket.name }
}
