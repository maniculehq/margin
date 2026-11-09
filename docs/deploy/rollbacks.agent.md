# Select content versions and roll back

The version selection, database inspection, retention settings, and Vercel rollback procedures below are your responsibility when self-hosting; [Manicule-hosted sites](/deploy/manicule) require no servers or environment variables and include the database and latest Margin release.

Restore production traffic to a previous Vercel application deployment and the content snapshot selected by that deployment. Use this procedure when an earlier successful production deployment has the documentation to restore; this is not a database rollback.

## Do this

Use an authenticated Vercel CLI, `psql`, and access to the database used by the target deployment. Choose an eligible previous production deployment; Hobby permits only the immediately previous production deployment, while Pro and Enterprise permit eligible earlier deployments.

Read the target deployment's build log for `[vercel-build] content version` and copy the following key into `TARGET_SHA`. Confirm the older application is compatible with the current database schema and external services before rollback; Vercel restores the old deployment's configuration, not newly edited project environment variables.

Run the following in Bash after replacing the target values and exporting `DATABASE_URL`. The query must return a `ready` or `superseded` row before running the rollback command; stop if the snapshot is unavailable.

```bash
set -euo pipefail
export SITE_SLUG='docs'
export TARGET_SHA='REPLACE_WITH_LOGGED_CONTENT_KEY'
export TARGET_DEPLOYMENT_URL='https://REPLACE_WITH_TARGET_DEPLOYMENT.vercel.app'

psql "$DATABASE_URL" \
  -v site_slug="$SITE_SLUG" \
  -v content_sha="$TARGET_SHA" \
  -v content_kind=production <<'SQL'
SELECT v.id, v.commit_sha, v.kind, v.status, v.seq, v.created_at,
       (v.id = s.current_version_id) AS is_current
FROM docs_content_version AS v
JOIN docs_site AS s ON s.id = v.site_id
WHERE s.slug = :'site_slug'
  AND v.commit_sha = :'content_sha'
  AND v.kind = :'content_kind'
ORDER BY v.seq DESC;
SQL

read -r -p 'Matching ready or superseded row exists? Type yes: ' confirmed
[ "$confirmed" = yes ]
vercel rollback "$TARGET_DEPLOYMENT_URL"
```

Wait for completion and confirm that Vercel assigned production domains to the target deployment. Run the content check in `Verify` before declaring recovery complete.

After Instant Rollback, Vercel disables automatic assignment of production domains to new pushes. Promote the corrected deployment through Vercel's [undo-rollback procedure](https://vercel.com/docs/instant-rollback#undo-a-rollback) to restore normal assignment.

## SDK

This procedure uses the Vercel CLI and `psql`, not an SDK.

## Facts

- A content version stores compiled pages, configuration, navigation, theme data, redirects, assets, and search content in Postgres.
- The content version key is the tuple of site, commit key, and kind (`production` or `preview`); `docs_content_version.id` identifies the row and `seq` orders ingest history.
- Product versions such as `v1` and `v2` are partitions within a content snapshot, not deployment-history entries.
- Normal publication creates a new key; rebuilding an existing key normally reuses the stored content row.
- The deployment build resolves `DOCS_CONTENT_SHA`, then `VERCEL_GIT_COMMIT_SHA`, then Git HEAD, then `dev-<unix ms>`, and bakes the resolved key into the server bundle.
- The default production deployment selects the baked content key with kind `production` and status `ready` or `superseded`.
- The default preview deployment (`VERCEL_ENV=preview`) selects the baked content key with kind `preview` and status `ready` or `superseded`.
- Local development without a baked key selects `docs_site.current_version_id`; the current selector requires a `ready` row.
- Production ingest advances the current pointer subject to ingest sequence ordering; preview ingest never advances the production pointer.
- The site must have status `active` to serve content.
- The inspection query's `is_current` column indicates the database pointer, not production-domain assignment.
- Failed ingest attempts may appear alongside a usable content row; failed rows cannot serve content.
- Custom extensions can override the default selection rules; the preview-prefix selector requires exactly one matching ready preview commit and serves nothing for ambiguous prefixes.
- Successful ingest triggers cleanup and protects the new version, the previous production pointer, and the current pointer.
- `DOCS_KEEP_VERSIONS` defaults to `20`, has minimum `1`, and retains the newest other production versions; production versions younger than 30 days are also retained.
- Unprotected production versions outside both count and age limits may be deleted; unprotected previews and failed attempts older than 30 days may be deleted.
- `DOCS_KEEP_VERSIONS` does not extend preview retention; watcher-created development versions may be collected sooner beyond the count.
- Versions with Blob references remain when referenced blobs cannot be deleted safely.
- Retention age uses the content row's `created_at`, not deployment creation; reuse does not refresh row age or sequence.
- `--force` or `DOCS_INGEST=force` atomically replaces an existing key with a fresh creation time and sequence; replacement changes content read by all deployments pinned to that key and can advance the production pointer.
- HTML and Markdown use the same content selection.

## Not supported

- Vercel Instant Rollback does not restore database writes, undo migrations, or rewrite `docs_site.current_version_id` by domain reassignment alone.
- Changing the production pointer alone does not change a deployed server's baked content key.
- A missing pinned content version does not fall back to the current pointer.
- Keeping an old application deployment does not by itself protect the deployment's content from cleanup.
- Rebuilding an already-ingested key does not create a fresh 30-day retention window.
- Forced ingest does not isolate replacement content to one deployment.
- Application rollback does not preserve current application code. Publish a new commit with the desired documentation for a content-only change.

If a content row was collected, redeploy the commit to ingest content again before assigning traffic. To refresh an existing production key deliberately, check out the matching commit, load target database credentials, and run this command with the actual docs directory and site slug:

```bash
bun scripts/ingest.ts \
  --dir docs \
  --slug docs \
  --sha "$TARGET_SHA" \
  --kind production \
  --force
```

Back up Postgres and any Blob store separately; deployment rollback is not a data backup.

## Errors

If the inspection query returns no usable row, stop before rollback and follow the missing-snapshot recovery instructions above.

## Verify

Set `PAGE_URL` to an existing public Markdown page on the production domain and `EXPECTED_TEXT` to an exact phrase unique to the intended snapshot. A successful check prints the phrase; no match means the content check failed and requires checking domain assignment and the selected row.

```bash
set -o pipefail
export PAGE_URL='https://docs.example.com/getting-started.md'
export EXPECTED_TEXT='REPLACE_WITH_EXACT_TARGET_ONLY_PHRASE'
curl --fail --silent --show-error "$PAGE_URL" \
  | grep -F -- "$EXPECTED_TEXT"
```

## Related

- [Host on Manicule](/deploy/manicule)
- [Configure selection through extensions](/extend/extensions)
- [Vercel Instant Rollback eligibility and permissions](https://vercel.com/docs/instant-rollback)
- [Vercel rollback CLI](https://vercel.com/docs/cli/rollback)
- [Undo a Vercel rollback](https://vercel.com/docs/instant-rollback#undo-a-rollback)
