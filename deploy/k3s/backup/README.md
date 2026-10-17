# Nightly portal backup (T-565)

`portal-backup.yaml` is a CronJob that runs at 02:17 UTC next to the portal:

1. `portal backup --nightly` takes an online copy of `/data/portal.db` through SQLite's backup API (safe while the portal
   writes), runs `PRAGMA quick_check` on it, gzips it to `/data/backups/nightly/portal-<UTC stamp>-nightly.db.gz` (mode 0600)
   and keeps the newest of each of the last 7 days plus the newest of each of the last 4 weeks.
2. `aws s3 sync` mirrors that folder off-site.

The portal reads the folder: `GET /api/admin/system` returns `nightlyBackup.stale = true` when there is no nightly backup or
the newest is older than 26 hours, and `portal status` prints `STALE`.

## Not applied

Argo CD syncs `deploy/k3s` without recursing, so nothing in this folder reaches the cluster. To apply it, the coordinator:

1. Creates the off-site bucket with versioning on and a noncurrent-version expiry (the mirror uses `--delete`; versioning
   keeps a wiped local folder from erasing the off-site history).
2. Creates the Secret named in place of `BACKUP_S3_SECRET`, keys `access-key-id` and `secret-access-key`, by hand, never in git.
3. Replaces the placeholders `BACKUP_S3_SECRET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX` and
   `BACKUP_S3_UPLOAD_IMAGE`, moves the file to `deploy/k3s/`, and lets the deploy pipeline bump its portal image tag with
   `portal.yaml`'s.

## Restore

The portal must be stopped for a restore; on this cluster that is production, so a person does it.

```sh
# 0. Check the backup first, anywhere (a scratch folder; the live database is never touched):
portal drill portal-20261014T021700Z-nightly.db.gz    # prints tables, rows and the time; fails on any row-count mismatch
# 1. Stop the portal (scale the Deployment to 0), and run the restore in a pod with the same volume and secret key:
portal restore /data/backups/nightly/portal-20261014T021700Z-nightly.db.gz
# 2. Start the portal: it starts Frozen. Check the workspaces, then "Resume delivery" on the Access page.
```

`portal restore` takes a `.db` or a `.db.gz`, checks integrity, schema and that the current key opens the backup's secrets,
keeps the replaced database as `backups/portal-<stamp>-replaced.db`, and leaves the portal Frozen.
