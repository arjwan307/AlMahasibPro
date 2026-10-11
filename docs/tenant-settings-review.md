# Tenant deletion and product isolation — review branch

Branch: fix/tenant-settings-product-isolation
Base: 0d876eff0ece5192241035f3ba101bbc525a5475

The active cloud/desktop path in this checkout uses SQLiteStore (cloud-server.js / enterprise-server.js), despite the older README describing PostgreSQL. Changes target that real path. No deployment, migration, reset generation, main update, or production database call was performed.

## Fixed failure paths

- Cloud snapshot imports now replace only the selected company and keep other companies, sessions, queues and deletion tombstones. Incoming foreign rows and identifier collisions are rejected. Deletion is rechecked under the transaction lock.
- Desktop restore no longer replaces the whole SQLite file or discards durable deletion markers.
- Company and user tombstones block old snapshots from restoring deleted identities/data. Ownership transfer receipts prevent an old snapshot from reverting the owner.
- Local replay checks cloud deletion before any upload, clears the local deleted tenant and detaches connection credentials. A durable pending-deletion flag blocks replay/new mutations after a lost cloud reply; retries reconcile against cloud state.
- Local cloud controls derive the company from the session and reject another cached tenant's connection.

## Settings and authorization

Settings page: /settings.html (cloud cashier: /retail/settings.html). Both product home pages link to it. Profile name changes affect the authenticated identity; company name/phone/address changes require company.manage. Identity IDs, product, company code and roles are not writable through these forms.

Destructive grants are independent: account.delete, company.delete, local.data.delete. Default company-admin/cashier roles do not receive them automatically. An authorized users.manage administrator must grant them explicitly through existing user administration. Company/local purge also requires full-company scope. Destructive requests require the exact phrase, current password and reason; cloud session/permissions are checked again inside the transaction. Secrets/destructive endpoints cannot enter desktop replay queues.

Account deletion anonymizes and disables only that account, revokes its sessions and preserves immutable financial actor IDs. Owners must first transfer ownership to another active manager from the same company with company.manage and users.manage and full scope; the settings page includes this flow. Linked local accounts delete centrally; standalone local accounts delete only locally.

Company deletion removes only the session's company. Platform deletion retains its separate developer-only authority and typed company-code confirmation, with mandatory company-scoped backup. No database-wide cloud purge API exists.

Local erase affects only the selected tenant, saves a verified backup, rejects unreviewed pending commands and durably disconnects automatic synchronization before erasure. Its local-only tombstone permits the same company to be adopted again only by an explicit authenticated cloud connection.

Backups are isolated SQLite files under deletion-backups/<UUID>.sqlite, with integrity_check verification and their IDs in durable audit evidence outside the purged company. Account backups contain recoverable personal information; administrators must control file access and set their retention policy. No backup is exposed as a public file.

## Product separation

- The Pro desktop and default Windows build now select company mode instead of unified mode; Cashier uses its existing independent identity, app-data directory and builder. Existing installation paths/data are preserved. Cashier entry pages and its artifact name now identify AlMahasibCashier; its appId and existing data path remain unchanged. No installer was built or distributed.
- Cloud product cookies/paths are separate, API login/bootstrap enforce product identity, company-only and retail-only modules are fenced even inside desktop-command replay, and cached shells/bootstrap keys are scoped to the product.
- The cloud may still share one physical SQLite store; isolation is by company UUID and product. Existing legacy retail migration is retained. A destructive split of the current shared database was deliberately not performed.
- The legacy explicitly requested unified runtime remains available for compatibility tests, but is no longer the Pro desktop default.

## Limits

- PostgreSQL destructive settings fail closed with 501 until there is a transactional, tenant-scoped backup/deletion adapter. TEST_DATABASE_URL and read-only PostgreSQL/MySQL import test sources were not supplied here, so actual database tests may be skipped.
- Browser/native Windows installer and real multi-device network QA are not claimed.
- Cloud deletion reaches an offline device only when it reconnects; the cloud rejects its old sessions immediately.
- Backups intentionally retain records for recovery and are not a legal erasure guarantee.

## Validation

Final test summary and commit links are recorded in the delivery report. Integration coverage includes cloud/local tenant purge, cross-company scopes, typed confirmation, wrong password, missing permission, backup failure rollback, owner transfer, account restore barriers, other-company sessions/queues, lost acknowledgements, pending-command rejection, restart persistence and product isolation.
