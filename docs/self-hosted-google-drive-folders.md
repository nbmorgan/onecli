# Self-hosted Google Drive folder support

Notes for anyone running the **self-hosted / OSS** build (`docker/Dockerfile`,
`cargo build --release` — no `--features cloud`). This feature re-implements, in
the OSS build, capabilities upstream ships only in the closed-source cloud
overlay. None of it requires the cloud repo.

> Heads-up: this fork is world-readable. The changes below intentionally enable,
> for self-hosted, things upstream treats as paid/cloud features. Keep that in
> mind before opening upstream PRs — the connector-only changes (new app/tool
> definitions) are likely palatable upstream; the cloud-replacing pieces
> (`condition_match`, the folder-scope request guard, the granular-access picker)
> are the parts upstream gates behind cloud and may not want.

## What was added

| Layer                      | File(s)                                                               | Upstream behavior                     | This fork                                         |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| Gateway condition matching | `apps/gateway/src/condition_match.rs`                                 | no-op stub (cloud-only)               | real query/body matcher                           |
| Gateway folder-scope guard | `apps/gateway/src/gateway/drive_scope.rs`, `gateway/hooks.rs`         | cloud `granular_access.rs` only       | OSS `pre_forward` guard                           |
| First-class Drive verbs    | `packages/api/src/apps/app-permissions/google-drive.ts`               | generic file tools only               | move/folder tools via conditions                  |
| OAuth scope/copy           | `packages/api/src/apps/google-drive.ts`                               | `drive.file`                          | full `drive` (see below)                          |
| Folder browser API         | `packages/api/src/services/google-drive-service.ts`, `routes/apps.ts` | none (Dropbox endpoint is cloud-only) | `/v1/apps/google-drive/(folders\|search-folders)` |
| sessionPolicy validation   | `packages/api/src/providers/hooks/google-drive-policy.ts`             | no-op default                         | shape validation for `google-drive`               |
| Folder-picker UI           | `apps/web/src/lib/granular-access/configs/google-drive*`              | OSS shows "Team" upsell               | real picker                                       |

## OAuth scope change (action required on redeploy)

The write scope changed from `https://www.googleapis.com/auth/drive.file` to the
full `https://www.googleapis.com/auth/drive`. `drive.file` only grants access to
files the app created/opened, so it cannot move or organize pre-existing
files/folders. **Existing Google Drive connections must be reconnected** to pick
up the broader grant. To keep a narrower posture, revert the scope in
`packages/api/src/apps/google-drive.ts` and accept that only OneCLI-created items
are writable.

## Rule condition schema (gateway)

Stored on `policy_rules.conditions` (JSONB), evaluated by
`condition_match::matches`. All present clauses AND together:

```jsonc
{
  "query_all": ["addParents"], // all query keys present
  "query_any": ["addParents", "removeParents"], // at least one present
  "query_absent": ["addParents", "removeParents"], // none present
  "body_json": { "mimeType": "application/vnd.google-apps.folder" },
  "body_json_not": { "mimeType": "application/vnd.google-apps.folder" },
}
```

Used to split the multiplexed `/drive/v3/files` endpoint: `move_file` vs
`update_file` (query), `create_folder` vs `create_file` (body mimeType). A rule
with no conditions matches exactly as before.

## Folder-scope policy (per agent connection)

Stored on `agent_app_connections.session_policy`:

```json
{ "folders": [{ "id": "16B14v…", "name": "Blaine & Fritz" }] }
```

Enforced by `gateway/drive_scope.rs` in `pre_forward`, with **whole-subtree**
semantics: a write into any descendant of an allowed folder is permitted. The
gateway walks the target folder's ancestors via the Drive API (cached 5m) and
allows if the target or any ancestor is in the allowed set; lookup failures fail
closed.

- **`root` (My Drive root):** selecting the `root` alias scopes the agent to My
  Drive's root and its whole subtree, so the agent can create new top-level
  folders (and anything under them) without re-registering each one. The gateway
  also resolves the account's canonical root id (`files/root`) and treats it as
  equivalent to the alias, since a top-level folder's `parents` reports the real
  id.
- **Enforced:** move into (`PATCH ?addParents`) and create into
  (`POST /drive/v3/files` body `parents`) a folder — target (or an ancestor)
  must be allowed; a create with no parent is denied unless `root` is allowed.
- **Not enforced (documented limits):** reads (`GET`) and deletes (`DELETE`)
  identify items by id only (would need a metadata lookup), and multipart
  uploads (`/upload/drive/...`) carry parents outside the JSON body.

## Tests

- `apps/gateway`: `cargo test -p onecli-gateway` (`condition_match::`,
  `policy::tests::drive_*`, `gateway::drive_scope::`).
- API/web: `pnpm --filter @onecli/api check-types`,
  `pnpm --filter @onecli/web check-types`.
