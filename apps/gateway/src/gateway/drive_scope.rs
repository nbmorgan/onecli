//! Google Drive folder-scope enforcement (self-hosted / OSS).
//!
//! Upstream enforces per-agent granular access (e.g. Dropbox folder allowlists)
//! only in the closed-source cloud request guard (`cloud/granular_access.rs`),
//! which the OSS build never compiles. This module is the OSS equivalent for
//! Google Drive: given the allowed-folder ids from a connection's
//! `session_policy`, it decides whether a write request stays within scope.
//!
//! ## What is enforced
//!
//! The folder a write *targets* is explicit in the request, so it can be checked
//! without an extra metadata lookup:
//! - **Move** — `PATCH /drive/v3/files/{id}?addParents=…`: every added parent
//!   must be an allowed folder (you cannot move an item into an out-of-scope
//!   folder). `removeParents` is unrestricted.
//! - **Create** — `POST /drive/v3/files` with a JSON body: every `parents[]`
//!   entry must be allowed, and a create with no parent (which would land in My
//!   Drive root) is denied when a scope is set.
//!
//! ## What is NOT enforced (documented limitations)
//!
//! - **Reads** (`GET`) and **deletes** (`DELETE`) identify the item only by id;
//!   the gateway would need a metadata lookup to know the item's folder, so they
//!   are not folder-scoped here.
//! - **Multipart uploads** (`/upload/drive/...`) carry parents in a multipart
//!   metadata part rather than a JSON body and are not inspected.
//!
//! The session-policy shape matches the web UI / validator:
//! `{ "folders": [{ "id": "…" }] }` (also accepts `{ "folderIds": [...] }` and a
//! bare `{ "folders": ["…"] }`).

use std::collections::HashSet;

use serde_json::Value;

/// Outcome of a folder-scope check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ScopeCheck {
    Allow,
    Deny(&'static str),
}

/// Collect the allowed folder ids from a connection `session_policy`.
/// Returns an empty set when no folder scope is configured.
pub(crate) fn allowed_folder_ids(session_policy: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    let obj = match session_policy.as_object() {
        Some(o) => o,
        None => return ids,
    };
    if let Some(arr) = obj.get("folderIds").and_then(Value::as_array) {
        for v in arr {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    ids.insert(s.to_string());
                }
            }
        }
    }
    if let Some(arr) = obj.get("folders").and_then(Value::as_array) {
        for v in arr {
            let id = match v {
                Value::String(s) => Some(s.as_str()),
                Value::Object(o) => o.get("id").and_then(Value::as_str),
                _ => None,
            };
            if let Some(s) = id {
                if !s.is_empty() {
                    ids.insert(s.to_string());
                }
            }
        }
    }
    ids
}

/// Does this request need its body buffered for a scope decision? Only a Drive
/// metadata create (`POST /drive/v3/files` with no `/upload/` prefix) carries
/// the target folder in a JSON body; moves use query params.
pub(crate) fn needs_body(host: &str, method: &str, path: &str) -> bool {
    is_drive_host(host)
        && method.eq_ignore_ascii_case("POST")
        && base_path(path) == "/drive/v3/files"
}

/// Decide whether a Drive write request stays within the allowed folders.
/// `path` includes the query string; `body` is the buffered request body when
/// available. Non-write or non-Drive requests are allowed.
pub(crate) fn check(
    host: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    allowed: &HashSet<String>,
) -> ScopeCheck {
    if allowed.is_empty() || !is_drive_host(host) {
        return ScopeCheck::Allow;
    }
    let base = base_path(path);

    if method.eq_ignore_ascii_case("PATCH") && is_file_item_path(base) {
        // Move: every added parent must be in scope.
        for parent in query_values(path, "addParents") {
            if !allowed.contains(&parent) {
                return ScopeCheck::Deny(
                    "move into a folder outside the connection's allowed Drive folders",
                );
            }
        }
        return ScopeCheck::Allow;
    }

    if method.eq_ignore_ascii_case("POST") && base == "/drive/v3/files" {
        // Create: parents from the JSON body must all be in scope.
        let parents = body.and_then(body_parents);
        match parents {
            Some(parents) if !parents.is_empty() => {
                for p in parents {
                    if !allowed.contains(&p) {
                        return ScopeCheck::Deny(
                            "create inside a folder outside the connection's allowed Drive folders",
                        );
                    }
                }
                ScopeCheck::Allow
            }
            // No explicit parent → lands in My Drive root, outside the scope.
            _ => ScopeCheck::Deny(
                "create outside the connection's allowed Drive folders (no in-scope parent)",
            ),
        }
    } else {
        ScopeCheck::Allow
    }
}

fn is_drive_host(host: &str) -> bool {
    let h = host.split(':').next().unwrap_or(host);
    h == "www.googleapis.com"
}

fn base_path(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

/// `/drive/v3/files/{id}` (an item path), not the collection `/drive/v3/files`.
fn is_file_item_path(base: &str) -> bool {
    base.strip_prefix("/drive/v3/files/")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// Comma-separated values of query parameter `key` (e.g. `addParents`).
fn query_values(path: &str, key: &str) -> Vec<String> {
    let query = match path.split_once('?') {
        Some((_, q)) => q,
        None => return Vec::new(),
    };
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return value
                .replace("%2C", ",")
                .replace("%2c", ",")
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
        }
    }
    Vec::new()
}

/// `parents` array from a JSON request body, if present.
fn body_parents(body: &[u8]) -> Option<Vec<String>> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let arr = value.get("parents")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn allowed(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allowed_ids_parses_all_shapes() {
        assert_eq!(
            allowed_folder_ids(&json!({ "folders": [{ "id": "a" }, { "id": "b" }] })),
            allowed(&["a", "b"])
        );
        assert_eq!(
            allowed_folder_ids(&json!({ "folders": ["a", "b"] })),
            allowed(&["a", "b"])
        );
        assert_eq!(
            allowed_folder_ids(&json!({ "folderIds": ["a"] })),
            allowed(&["a"])
        );
        assert!(allowed_folder_ids(&json!({})).is_empty());
    }

    #[test]
    fn empty_scope_allows_everything() {
        let none = allowed(&[]);
        assert_eq!(
            check(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/x?addParents=anything",
                None,
                &none
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn non_drive_host_allowed() {
        assert_eq!(
            check(
                "api.dropbox.com",
                "POST",
                "/drive/v3/files",
                None,
                &allowed(&["a"])
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn move_into_allowed_folder_ok() {
        assert_eq!(
            check(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/abc?addParents=good&removeParents=root",
                None,
                &allowed(&["good"])
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn move_into_disallowed_folder_denied() {
        assert!(matches!(
            check(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/abc?addParents=evil",
                None,
                &allowed(&["good"])
            ),
            ScopeCheck::Deny(_)
        ));
    }

    #[test]
    fn move_with_multiple_parents_all_must_be_allowed() {
        assert!(matches!(
            check(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/abc?addParents=good,evil",
                None,
                &allowed(&["good"])
            ),
            ScopeCheck::Deny(_)
        ));
    }

    #[test]
    fn metadata_patch_without_move_allowed() {
        assert_eq!(
            check(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/abc?fields=id",
                None,
                &allowed(&["good"])
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn create_in_allowed_folder_ok() {
        let body = br#"{"name":"f","parents":["good"]}"#;
        assert_eq!(
            check(
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
                Some(body),
                &allowed(&["good"])
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn create_in_disallowed_folder_denied() {
        let body = br#"{"name":"f","parents":["evil"]}"#;
        assert!(matches!(
            check(
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
                Some(body),
                &allowed(&["good"])
            ),
            ScopeCheck::Deny(_)
        ));
    }

    #[test]
    fn create_without_parent_denied_when_scoped() {
        let body = br#"{"name":"f"}"#;
        assert!(matches!(
            check(
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
                Some(body),
                &allowed(&["good"])
            ),
            ScopeCheck::Deny(_)
        ));
    }

    #[test]
    fn reads_and_deletes_not_scoped() {
        let a = allowed(&["good"]);
        assert_eq!(
            check("www.googleapis.com", "GET", "/drive/v3/files/abc", None, &a),
            ScopeCheck::Allow
        );
        assert_eq!(
            check(
                "www.googleapis.com",
                "DELETE",
                "/drive/v3/files/abc",
                None,
                &a
            ),
            ScopeCheck::Allow
        );
    }

    #[test]
    fn needs_body_only_for_metadata_create() {
        assert!(needs_body("www.googleapis.com", "POST", "/drive/v3/files"));
        assert!(!needs_body(
            "www.googleapis.com",
            "POST",
            "/upload/drive/v3/files"
        ));
        assert!(!needs_body(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x"
        ));
        assert!(!needs_body("api.dropbox.com", "POST", "/drive/v3/files"));
    }
}
