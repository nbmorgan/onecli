# SPEC: OneCLI Google Drive Folder Support

## Status

Drafted from live probing on 2026-06-21 against the active OneCLI deployment and source at `~/develop/onecli`.

## Goal

Make Google Drive folder workflows first-class in OneCLI across:

1. OAuth/app capability declaration
2. permission modeling and policy rules
3. API/runtime/gateway enforcement
4. web UI connection and granular-access flows

This should let an agent reliably:

- discover folders
- browse folder contents
- create folders
- move files into folders
- inspect folder metadata
- optionally scope an agent to a subset of Drive folders

without forcing callers to hand-craft raw Drive API requests or treat folders as an undocumented side effect of generic file PATCH calls.

---

## Problem Statement

### What works today

Live raw Google Drive API calls through OneCLI now work for:

- `GET /drive/v3/about`
- `GET /drive/v3/files` folder search
- `GET /drive/v3/files/{id}` metadata

This proves:

- the `google-drive` connection can be healthy
- gateway host routing for Drive works
- raw Drive folder search/read/metadata are viable through OneCLI

### What does not work well today

1. Folder operations are not exposed as first-class product concepts.
2. Move/update semantics are hidden inside generic `PATCH /drive/v3/files/*`.
3. The web UI does not expose Google Drive granular folder scoping.
4. The permission model cannot distinguish parent changes from generic metadata updates.
5. The current Drive app scope/copy suggests narrower semantics than the product description promises.
6. Drive write behavior may also be blocked by generic policy rules that are too coarse to express safe folder-only allowances.

### Key live observation

A live attempt to move a Google Doc into an existing folder (`Blaine & Fritz`) via raw Drive API succeeded at the Google/API layer shape but was blocked by an explicit OneCLI policy rule:

- rule name: `block-hermes-drive-update`
- blocked request shape: `PATCH /drive/v3/files/{id}?addParents=...&removeParents=...`

This means the current blocker is not only “missing Google support”; it is also that the OneCLI rule model sees folder moves as the same generic `update_file` primitive as all other Drive PATCH operations.

---

## Source Evidence

### App definition / scopes

`packages/api/src/apps/google-drive.ts`

- declares description: `Read, create, and manage files and folders.`
- requests scopes:
  - `openid`
  - `email`
  - `profile`
  - `https://www.googleapis.com/auth/drive.readonly`
  - `https://www.googleapis.com/auth/drive.file`
- permission copy for write scope:
  - `Manage app files`
  - `Create and edit files opened or created by OneCLI`

### Drive permission/tool surface

`packages/api/src/apps/app-permissions/google-drive.ts`
Defines only generic file tools:

- `list_files`
- `get_file`
- `get_file_metadata`
- `search_files`
- `create_file`
- `update_file`
- `delete_file`
- `share_file`

Missing first-class folder tools such as:

- create folder
- list folder children
- get folder metadata
- move file / update parents
- delete folder
- list permissions / update permissions

### Granular access UI registration

`apps/web/src/lib/granular-access/index.ts`
Only registers:

- `github-app`
- `dropbox`

There is no `google-drive` granular access config.

### Dropbox comparison

`apps/web/src/lib/granular-access/configs/dropbox.ts`
Shows the intended pattern for folder-scoped access:

- item label: folder/folders
- `buildPolicy` -> `{ folders }`
- `getSelectedItems` from policy
- summary formatting

`apps/web/src/lib/api/dropbox.ts`
Provides a first-class folder browser endpoint for the UI.

`apps/web/src/lib/api/types.ts`
Defines `DropboxFolder`, but no analogous `GoogleDriveFolder`.

### Agent access dialog

`apps/web/src/app/(dashboard)/agents/_components/manage-access-dialog.tsx`
Uses `granularAccessConfigs` to decide whether a provider gets granular-access UI. Because `google-drive` is absent there, the Drive connection cannot present folder-scoping UI even though the agent connection model already supports `sessionPolicy`.

### Generic policy validator hook

`packages/api/src/providers/hooks/policy-validator.ts`
Contains a default no-op validator:

- `validate: async () => {}`

This indicates provider-specific session-policy validation exists as an extension point but Google Drive does not currently use it.

### Gateway/provider routing

`apps/gateway/src/apps.rs`
The gateway has host routing for Drive, so the transport layer is not the issue once auth is healthy.

---

## Root Cause Summary

This is a stack gap, not one missing line.

### Layer 1: Capability declaration mismatch

The Drive app is described as managing files and folders, but the exposed scope copy and tool model are still app-file-centric and generic-file-centric.

### Layer 2: Permission model is too coarse

Folder creation, folder browsing, and parent mutation are not first-class operations. They are collapsed into generic file operations.

### Layer 3: No Drive-specific granular access model

The connection/agent model supports per-connection `sessionPolicy`, but Google Drive has no provider-specific validator, UI, or enforcement scheme for folder scoping.

### Layer 4: Web UI is missing the folder product surface

The web app has a Dropbox folder-scoping pattern but no Google Drive equivalent.

---

## Desired Behavior

### Connection-level behavior

When a Google Drive account is connected, OneCLI should support:

- folder search
- folder metadata reads
- folder creation
- moving files into folders
- optional folder-scoped connection/agent restrictions

### Policy-level behavior

OneCLI policy should distinguish at least:

- read/search metadata
- create folder
- create file
- move file between folders / update parents
- delete file
- delete folder
- share file/folder

### UI behavior

In the Connections / Agents UI, Google Drive should support:

- browsing/selecting folders for granular access
- summarizing selected folder scope
- clearly labeling folder operations separately from generic file updates

---

## Proposed Changes

## A. App definition and OAuth scopes

### Files

- `packages/api/src/apps/google-drive.ts`

### Changes

1. Re-evaluate default write scopes for Google Drive.
2. If the intended product behavior includes managing arbitrary existing folders/files, `drive.file` alone is likely too narrow semantically and in UX copy.
3. Update permission copy so it accurately matches implemented behavior.

### Minimum acceptance

- Scope descriptions in the UI align with actual folder-management behavior.
- Reconnect flow presents the correct Google consent expectation.

### Notes

If maintaining a narrower security posture is important, document exactly which folder workflows are supported under `drive.file` and which require a broader scope. But avoid claiming “manage files and folders” if only app-created items are safely writable.

---

## B. Add first-class Google Drive folder tools

### Files

- `packages/api/src/apps/app-permissions/google-drive.ts`

### Add new tool definitions

Read:

- `list_folder_children` -> `GET /drive/v3/files` with folder-parent query semantics
- `get_folder_metadata` -> `GET /drive/v3/files/*` with folder mimeType semantics
- optionally `list_file_permissions` -> `GET /drive/v3/files/*/permissions`

Write:

- `create_folder` -> `POST /drive/v3/files` with `mimeType=application/vnd.google-apps.folder`
- `move_file` or `update_parents` -> `PATCH /drive/v3/files/*` with `addParents/removeParents`
- `delete_folder` -> `DELETE /drive/v3/files/*`
- optionally `update_file_permissions` / `share_folder`

### Important implementation note

If the current app-permission abstraction can only match by method+host+path, then `move_file` must either:

1. be treated as a special-case semantic classifier on Drive PATCH requests, or
2. remain a UI/product alias over `update_file` but with backend request inspection to separate parent mutation from generic metadata change.

### Minimum acceptance

- Google Drive permission groups in the UI show explicit folder operations.
- Policy rules can target folder move/create behavior independently of generic file updates.

---

## C. Add a Drive-specific granular-access model

### Files

- `packages/api/src/providers/hooks/policy-validator.ts`
- provider-specific validator implementation location as appropriate in API package
- `packages/api/src/validations/agent.ts` (schema already generic enough; likely no major change)
- any runtime enforcement code used when agent connections carry `sessionPolicy`

### Proposed policy shape

```json
{
  "folders": [
    {
      "id": "16B14v-8kP_o5Vk0EaGD6HBUb1ZAW9fMy",
      "name": "Blaine & Fritz"
    }
  ]
}
```

Alternative minimal shape:

```json
{ "folderIds": ["16B14v-8kP_o5Vk0EaGD6HBUb1ZAW9fMy"] }
```

### Validation behavior

The validator should:

- ensure the connection provider is `google-drive`
- ensure selected folders are valid Drive folder IDs
- optionally live-verify selected folder metadata using the chosen connection
- reject malformed policy payloads

### Runtime enforcement behavior

For a folder-scoped Google Drive connection, gateway/API enforcement should:

- allow reads on the scoped folder IDs and descendants
- allow file creates inside scoped folders if write is granted
- allow parent updates only when target parents remain within scope
- block moves outside allowed folders

### Minimum acceptance

- `sessionPolicy` for Google Drive is validated and not silently ignored.
- Agent assignments can restrict a Drive connection to selected folders.

---

## D. Add web UI for Drive folder selection

### Files

- `apps/web/src/lib/granular-access/index.ts`
- new file: `apps/web/src/lib/granular-access/configs/google-drive.ts`
- new API client, e.g. `apps/web/src/lib/api/google-drive.ts`
- `apps/web/src/lib/api/types.ts`
- possibly a folder browser component under the connections/agents UI

### Required UI pieces

1. Register `google-drive` in `granularAccessConfigs`.
2. Add a `GoogleDriveFolder` type in `apps/web/src/lib/api/types.ts`.
3. Add a folder browser/search client analogous to Dropbox, e.g.:
   - `folders(connectionId, parentId?)`
   - `searchFolders(connectionId, query)`
4. Add a Google Drive granular config analogous to Dropbox:
   - `isSupported`
   - `getItems`
   - `buildPolicy`
   - `getSelectedItems`
   - `formatSummary`
   - folder icon/labels
5. Render selected folder scope in Agents and Rules summaries.

### Minimum acceptance

- A user can open Manage Access for an agent, choose a Google Drive connection, and scope it to one or more folders through the UI.
- The chosen Drive folder scope round-trips through save/reload/edit flows.

---

## E. Add Drive folder API helpers for the UI

### Candidate endpoints

Add API endpoints similar in spirit to Dropbox folder helpers, for example:

- `GET /v1/apps/google-drive/folders?connectionId=...&parentId=...`
- `GET /v1/apps/google-drive/search-folders?connectionId=...&q=...`
- optionally `GET /v1/apps/google-drive/folder?id=...&connectionId=...`

These endpoints should:

- use the specified app connection
- return folder-only items
- support shared drives when possible
- hide raw Drive query syntax from the UI

### Minimum acceptance

- The UI never has to hand-craft Drive query strings to browse/select folders.

---

## F. Improve policy-rule semantics for Drive PATCH

### Problem

Today `PATCH /drive/v3/files/*` is too broad. Parent moves and ordinary updates are both `update_file`.

### Proposed options

#### Option 1: Request classifier (preferred)

Add Drive-specific request classification in the gateway/API layer:

- if PATCH contains `addParents`/`removeParents`, classify as `move_file`
- otherwise classify as `update_file`

#### Option 2: Coarser but explicit product alias

Keep one PATCH endpoint but expose two rule/tool labels and resolve them by request-shape inspection before policy evaluation.

### Minimum acceptance

- A rule that blocks generic updates does not necessarily have to block folder moves.
- A rule can allow moves into approved folders while still blocking generic metadata mutation if desired.

---

## Non-Goals

- Full Google Drive desktop-like file manager UI
- Solving all Google shared-drive edge cases in v1
- Cross-provider abstraction beyond what is needed for Google Drive parity with Dropbox folder scoping

---

## Suggested Implementation Order

### Phase 1: Product truthfulness + first-class verbs

- update scope/capability copy
- add explicit Drive folder/move tool definitions
- add request classification for parent updates

### Phase 2: UI support

- add Google Drive granular access config
- add folder browser/search endpoints and types
- wire Manage Access dialog and summaries

### Phase 3: Scoped enforcement

- add Google Drive `sessionPolicy` validator
- add runtime enforcement for folder-scoped access

### Phase 4: hardening

- shared drive coverage
- better permission summaries
- tests for policy interactions and reconnect flows

---

## Acceptance Tests

### Live functional tests

1. Connect a Google Drive account.
2. Search for an existing folder by name.
3. Read folder metadata.
4. Create a new folder.
5. Move an existing file into a selected folder.
6. Verify file parent changed correctly.
7. Share a file inside a scoped folder.

### UI tests

1. Drive connection appears with granular-access UI.
2. User can pick one or more folders.
3. Saved folder scope shows correctly on reload.
4. Rules summary displays folder scope clearly.

### Policy tests

1. Rule can allow `create_folder` while blocking `delete_folder`.
2. Rule can allow `move_file` while blocking generic `update_file`.
3. Folder-scoped agent cannot move a file outside approved folders.
4. Non-scoped Drive connection still behaves as global Drive access per policy.

---

## Temporary Workaround (until spec is implemented)

Use raw Google Drive API calls through OneCLI with explicit `x-onecli-connection-id` for:

- folder search
- folder metadata
- file metadata
- parent-change/move operations

Caveat:

- move/update operations may still be blocked by existing OneCLI policy rules unless those rules are relaxed or made more specific.

---

## Implementation Handoff Summary for Claude

The current OneCLI Google Drive integration is transport-capable but product-thin. Folders are reachable only as generic Drive files. Implement first-class folder support by adding explicit folder/move verbs to the Google Drive permission model, wiring a Google Drive granular-access config and folder browser into the web UI, and adding Drive-specific `sessionPolicy` validation/enforcement so agents can be safely scoped to selected folders.
