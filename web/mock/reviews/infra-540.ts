// acme/infra#540: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "envs/staging/kms.tf",
      "modified",
      `@@ -1,10 +1,12 @@
-resource "aws_kms_key" "app_data" {
-  description             = "staging app data"
+# Rotated 2026-11: new keys, the aliases moved onto them.
+resource "aws_kms_key" "app_data_2026" {
+  description             = "staging app data, from 2026-11"
   deletion_window_in_days = 7
+  enable_key_rotation     = true
   tags                    = local.tags
 }

 resource "aws_kms_alias" "app_data" {
   name          = "alias/staging-app-data"
-  target_key_id = aws_kms_key.app_data.key_id
+  target_key_id = aws_kms_key.app_data_2026.key_id
 }
@@ -12,10 +14,11 @@ resource "aws_kms_alias" "app_data" {
-resource "aws_kms_key" "backups" {
-  description             = "staging backups"
+resource "aws_kms_key" "backups_2026" {
+  description             = "staging backups, from 2026-11"
   deletion_window_in_days = 7
+  enable_key_rotation     = true
   tags                    = local.tags
 }

 resource "aws_kms_alias" "backups" {
   name          = "alias/staging-backups"
-  target_key_id = aws_kms_key.backups.key_id
+  target_key_id = aws_kms_key.backups_2026.key_id
 }`,
    ),
    file(
      "envs/staging/database.tf",
      "modified",
      `@@ -9,7 +9,7 @@ resource "aws_db_instance" "main" {
   instance_class          = "db.t4g.large"
   allocated_storage       = 100
   storage_encrypted       = true
-  kms_key_id              = aws_kms_key.app_data.arn
+  kms_key_id              = aws_kms_key.app_data_2026.arn
   backup_retention_period = 7
   skip_final_snapshot     = true
   tags                    = local.tags
@@ -31,5 +31,5 @@ resource "aws_db_instance_automated_backups_replication" "main" {
   source_db_instance_arn = aws_db_instance.main.arn
-  kms_key_id             = aws_kms_key.backups.arn
+  kms_key_id             = aws_kms_key.backups_2026.arn
   retention_period       = 7
   provider               = aws.backup_region
 }
@@ -44,7 +44,7 @@ resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
   rule {
     apply_server_side_encryption_by_default {
       sse_algorithm     = "aws:kms"
-      kms_master_key_id = aws_kms_key.app_data.arn
+      kms_master_key_id = aws_kms_key.app_data_2026.arn
     }
   }
 }`,
    ),
  ],
  ai: {
    verdict: "look",
    risk: "high",
    summary:
      "Replaces staging's two KMS keys, app data and backups, with new ones that have yearly rotation on, moves both aliases onto them, and points the database, its backup replication and the exports bucket at the new keys. The old keys leave the config, so Terraform schedules them for deletion.",
    concerns: [
      "A database's storage key can't change in place: the new `kms_key_id` on `aws_db_instance.main` makes the plan destroy and recreate the staging database, and with `skip_final_snapshot = true` nothing is kept. Moving it to a new key means a snapshot copied under that key and a restore; or leave the instance on its key.",
      "Dropping `aws_kms_key.app_data` and `backups` schedules both for deletion after 7 days. Objects already in the exports bucket and the replicated backups stay encrypted under the old keys (a new default key doesn't re-encrypt them), so they become unreadable once the keys are gone.",
    ],
    notes: [
      {
        path: "envs/staging/kms.tf",
        side: "new",
        line: 5,
        body: "On its own, on the existing keys, this is rotation: new key material every year under the same key id, with old data still readable. That would get what the PR is after without replacing either key.",
      },
      {
        path: "envs/staging/database.tf",
        side: "new",
        line: 12,
        body: "The change that forces the database's replacement; `terraform plan` shows it as `-/+` on `aws_db_instance.main`.",
      },
      {
        path: "envs/staging/database.tf",
        side: "new",
        line: 47,
        body: "Only new objects use the new key; everything already in the bucket keeps the old one.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h3", path: "envs/staging/database.tf", level: "look", why: "new storage key replaces the database" },
        { id: "h1", path: "envs/staging/kms.tf", level: "look", why: "old key dropped, scheduled for deletion" },
        { id: "h5", path: "envs/staging/database.tf", level: "skim", why: "old objects keep the old key" },
        { id: "h2", path: "envs/staging/kms.tf", level: "skim", why: "same change for the backups key" },
        { id: "h4", path: "envs/staging/database.tf", level: "skim", why: "backup replication on the new key" },
      ],
      unread: [],
      total: 5,
    },
    guide: {
      steps: [
        {
          title: "New keys, aliases moved",
          body: "Both keys are replaced by new ones with rotation on, and each alias now points at its new key. The old keys are no longer in the config.",
          check: "What still needs the old keys after their 7-day deletion window.",
          hunks: [
            { id: "h1", path: "envs/staging/kms.tf" },
            { id: "h2", path: "envs/staging/kms.tf" },
          ],
        },
        {
          title: "What uses the keys",
          body: "The database, its backup replication and the exports bucket move to the new keys.",
          check: "The plan doesn't replace `aws_db_instance.main`.",
          hunks: [
            { id: "h3", path: "envs/staging/database.tf" },
            { id: "h4", path: "envs/staging/database.tf" },
            { id: "h5", path: "envs/staging/database.tf" },
          ],
        },
      ],
    },
  },
};
