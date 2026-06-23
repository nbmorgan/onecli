//! Google Drive folder-scope enforcement (self-hosted / OSS).
//!
//! Upstream enforces per-agent granular access (e.g. Dropbox folder allowlists)
//! only in the closed-source cloud request guard (`cloud/granular_access.rs`),
//! which the OSS build never compiles. This module is the OSS equivalent for
//! Google Drive: given the allowed-folder ids from a connection's
//! `session_policy`, it decides whether a write request stays within scope.
//!
//! ## Subtree semantics
//!
//! Allowing a folder allows its **entire subtree** — a write into any descendant
//! of an allowed folder is permitted. Because the gateway only sees the target
//! folder id, it walks that folder's ancestors (via the Drive API, cached) and
//! allows the write if the target *or any ancestor* is in the allowed set.
//!
//! ## What is enforced
//!
//! - **Move** — `PATCH /drive/v3/files/{id}?addParents=…`: every added parent
//!   must be within an allowed subtree. `removeParents` is unrestricted.
//! - **Create** — `POST /drive/v3/files` with a JSON body: every `parents[]`
//!   entry must be within an allowed subtree; a create with no parent (which
//!   lands in My Drive root) is denied when a scope is set.
//!
//! ## What is NOT enforced (documented limitations)
//!
//! - **Reads** (`GET`) and **deletes** (`DELETE`) identify the item only by id;
//!   the gateway does not folder-scope them.
//! - **Multipart uploads** (`/upload/drive/...`) carry parents outside the JSON
//!   body and are not inspected.
//!
//! Session-policy shape matches the web UI / validator:
//! `{ "folders": [{ "id": "…" }] }` (also accepts `{ "folderIds": [...] }` and a
//! bare `{ "folders": ["…"] }`).

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use serde_json::Value;

use crate::cache::CacheStore;

/// Cap on ancestor lookups per target folder (cycle/runaway guard).
const MAX_ANCESTOR_NODES: usize = 50;
/// TTL for cached folder→parents lookups.
const PARENTS_CACHE_TTL_SECS: u64 = 300;
/// Drive's alias for the account's My Drive root. Selecting it scopes the agent
/// to the root and its whole subtree, so newly-created top-level folders are
/// automatically in scope without re-registering them.
pub(crate) const ROOT_ALIAS: &str = "root";

/// Outcome of a folder-scope check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ScopeCheck {
    Allow,
    Deny(&'static str),
}

/// What a request targets, for scope purposes.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// Not a scoped write (read, delete, plain metadata update, …).
    Ignore,
    /// A create with no parent → lands in My Drive root, outside any scope.
    DenyNoParent,
    /// Folder ids the write targets; each must be within an allowed subtree.
    Check(Vec<String>),
}

/// Collect the allowed folder ids from a connection `session_policy`.
pub(crate) fn allowed_folder_ids(session_policy: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Some(obj) = session_policy.as_object() else {
        return ids;
    };
    if let Some(arr) = obj.get("folderIds").and_then(Value::as_array) {
        for v in arr {
            if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                ids.insert(s.to_string());
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
            if let Some(s) = id.filter(|s| !s.is_empty()) {
                ids.insert(s.to_string());
            }
        }
    }
    ids
}

/// Only a Drive metadata create (`POST /drive/v3/files`, not `/upload/`) carries
/// the target folder in a JSON body; moves use query params.
pub(crate) fn needs_body(host: &str, method: &str, path: &str) -> bool {
    is_drive_host(host)
        && method.eq_ignore_ascii_case("POST")
        && base_path(path) == "/drive/v3/files"
}

/// What folders, if any, this request targets for scope enforcement.
fn extract_target(host: &str, method: &str, path: &str, body: Option<&[u8]>) -> Target {
    if !is_drive_host(host) {
        return Target::Ignore;
    }
    let base = base_path(path);

    if method.eq_ignore_ascii_case("PATCH") && is_file_item_path(base) {
        let add = query_values(path, "addParents");
        return if add.is_empty() {
            Target::Ignore // plain metadata update, not a move
        } else {
            Target::Check(add)
        };
    }

    if method.eq_ignore_ascii_case("POST") && base == "/drive/v3/files" {
        return match body.and_then(body_parents) {
            Some(parents) if !parents.is_empty() => Target::Check(parents),
            _ => Target::DenyNoParent,
        };
    }

    Target::Ignore
}

/// Is `target` inside an allowed subtree — i.e. is the target itself, or any of
/// its ancestors, in `allowed`? `get_parents` resolves a folder's parent ids
/// (returns `None` when they cannot be determined, which fails closed).
pub(crate) async fn folder_in_scope<'a, F>(
    target: &str,
    allowed: &HashSet<String>,
    mut get_parents: F,
) -> bool
where
    F: FnMut(String) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + 'a>>,
{
    if allowed.contains(target) {
        return true;
    }
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(target.to_string());
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(target.to_string());

    let mut nodes = 0usize;
    while let Some(id) = queue.pop_front() {
        if nodes >= MAX_ANCESTOR_NODES {
            break;
        }
        nodes += 1;
        let Some(parents) = get_parents(id).await else {
            continue;
        };
        for p in parents {
            if allowed.contains(&p) {
                return true;
            }
            if visited.insert(p.clone()) {
                queue.push_back(p);
            }
        }
    }
    false
}

/// Evaluate a request against the allowed folders, resolving subtrees via
/// `get_parents`. Generic over the resolver so the decision logic is unit
/// testable with an in-memory parent map.
pub(crate) async fn evaluate<'a, F>(
    host: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    allowed: &HashSet<String>,
    mut get_parents: F,
) -> ScopeCheck
where
    F: FnMut(String) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + 'a>>,
{
    if allowed.is_empty() {
        return ScopeCheck::Allow;
    }
    match extract_target(host, method, path, body) {
        Target::Ignore => ScopeCheck::Allow,
        // A parent-less create lands in My Drive root, which is in scope only
        // when the root itself is an allowed folder.
        Target::DenyNoParent if allowed.contains(ROOT_ALIAS) => ScopeCheck::Allow,
        Target::DenyNoParent => ScopeCheck::Deny(
            "create outside the connection's allowed Drive folders (no in-scope parent)",
        ),
        Target::Check(targets) => {
            for t in targets {
                if !folder_in_scope(&t, allowed, &mut get_parents).await {
                    return ScopeCheck::Deny(
                        "target folder is outside the connection's allowed Drive folders",
                    );
                }
            }
            ScopeCheck::Allow
        }
    }
}

/// Reusable Drive client for ancestor lookups (cheap to clone, reused).
fn drive_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Resolve the account's real My Drive root folder id (the `root` alias resolves
/// to this canonical id, which is what a top-level folder's `parents` reports).
/// Cached aggressively since it is stable per account. Returns `None` on failure.
pub(crate) async fn resolve_root_id(cache: &dyn CacheStore, token: &str) -> Option<String> {
    // Key off a non-reversible fingerprint of the token so we don't store the
    // token itself in the cache, while still being per-account.
    let key = format!("gdrive:rootid:{}", token_fingerprint(token));
    if let Some(id) = cache.get_raw(&key).await {
        return Some(id);
    }
    let resp = drive_client()
        .get("https://www.googleapis.com/drive/v3/files/root?fields=id")
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let id = body.get("id")?.as_str()?.to_string();
    cache.set_raw(&key, &id, 86_400).await;
    Some(id)
}

/// Cheap, non-reversible fingerprint of an access token for cache keying.
fn token_fingerprint(token: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Resolve a folder's parent ids via the Drive API, caching the result. Returns
/// `None` on any failure (no token, network error, non-2xx) so callers fail
/// closed. Used as the real `get_parents` for [`evaluate`].
pub(crate) async fn resolve_parents(
    cache: &dyn CacheStore,
    token: &str,
    id: &str,
) -> Option<Vec<String>> {
    let key = format!("gdrive:parents:{id}");
    if let Some(raw) = cache.get_raw(&key).await {
        return serde_json::from_str(&raw).ok();
    }
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{id}?fields=parents&supportsAllDrives=true"
    );
    let resp = drive_client()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let parents: Vec<String> = body
        .get("parents")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if let Ok(serialized) = serde_json::to_string(&parents) {
        cache
            .set_raw(&key, &serialized, PARENTS_CACHE_TTL_SECS)
            .await;
    }
    Some(parents)
}

fn is_drive_host(host: &str) -> bool {
    host.split(':').next().unwrap_or(host) == "www.googleapis.com"
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
    let Some((_, query)) = path.split_once('?') else {
        return Vec::new();
    };
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return value
                .replace("%2C", ",")
                .replace("%2c", ",")
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
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
    use std::collections::HashMap;

    fn allowed(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// Build a `get_parents` resolver from an id→parents map.
    fn resolver(
        map: HashMap<&'static str, Vec<&'static str>>,
    ) -> impl FnMut(String) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>> {
        move |id: String| {
            let parents = map
                .get(id.as_str())
                .map(|ps| ps.iter().map(|s| s.to_string()).collect::<Vec<_>>());
            Box::pin(async move { parents })
        }
    }

    fn no_lookup() -> impl FnMut(String) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
    {
        |_id: String| Box::pin(async { None }) as _
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
    fn extract_target_classifies_requests() {
        assert_eq!(
            extract_target(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/x?addParents=a,b",
                None
            ),
            Target::Check(vec!["a".into(), "b".into()])
        );
        assert_eq!(
            extract_target(
                "www.googleapis.com",
                "PATCH",
                "/drive/v3/files/x?fields=id",
                None
            ),
            Target::Ignore
        );
        assert_eq!(
            extract_target(
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
                Some(br#"{"parents":["a"]}"#)
            ),
            Target::Check(vec!["a".into()])
        );
        assert_eq!(
            extract_target(
                "www.googleapis.com",
                "POST",
                "/drive/v3/files",
                Some(br#"{}"#)
            ),
            Target::DenyNoParent
        );
        assert_eq!(
            extract_target("api.dropbox.com", "POST", "/drive/v3/files", None),
            Target::Ignore
        );
        assert_eq!(
            extract_target("www.googleapis.com", "GET", "/drive/v3/files/x", None),
            Target::Ignore
        );
    }

    #[tokio::test]
    async fn empty_scope_allows_everything() {
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=anything",
            None,
            &allowed(&[]),
            no_lookup(),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn direct_allowed_folder_needs_no_lookup() {
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=good",
            None,
            &allowed(&["good"]),
            no_lookup(),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn subtree_descendant_is_allowed() {
        // child → mid → good(allowed). Moving into `child` is allowed.
        let map = HashMap::from([("child", vec!["mid"]), ("mid", vec!["good"])]);
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=child",
            None,
            &allowed(&["good"]),
            resolver(map),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn outside_subtree_is_denied() {
        // evil → root. No allowed ancestor.
        let map = HashMap::from([("evil", vec!["root"]), ("root", vec![])]);
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=evil",
            None,
            &allowed(&["good"]),
            resolver(map),
        )
        .await;
        assert!(matches!(r, ScopeCheck::Deny(_)));
    }

    #[tokio::test]
    async fn unresolvable_parents_fail_closed() {
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=unknown",
            None,
            &allowed(&["good"]),
            no_lookup(),
        )
        .await;
        assert!(matches!(r, ScopeCheck::Deny(_)));
    }

    #[tokio::test]
    async fn root_scope_allows_parentless_create() {
        // Selecting "root" lets the agent create new top-level folders.
        let r = evaluate(
            "www.googleapis.com",
            "POST",
            "/drive/v3/files",
            Some(br#"{"name":"new-top-level"}"#),
            &allowed(&["root"]),
            no_lookup(),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn root_scope_allows_move_into_top_level_via_real_root_id() {
        // hooks augments the allowed set with the account's real root id; a
        // top-level folder's parent is that real id.
        let map = HashMap::from([("toplevel", vec!["0ARealRootId"])]);
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=toplevel",
            None,
            &allowed(&["root", "0ARealRootId"]),
            resolver(map),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn create_without_parent_denied_when_scoped() {
        let r = evaluate(
            "www.googleapis.com",
            "POST",
            "/drive/v3/files",
            Some(br#"{"name":"f"}"#),
            &allowed(&["good"]),
            no_lookup(),
        )
        .await;
        assert!(matches!(r, ScopeCheck::Deny(_)));
    }

    #[tokio::test]
    async fn create_in_descendant_allowed() {
        let map = HashMap::from([("child", vec!["good"])]);
        let r = evaluate(
            "www.googleapis.com",
            "POST",
            "/drive/v3/files",
            Some(br#"{"name":"f","parents":["child"]}"#),
            &allowed(&["good"]),
            resolver(map),
        )
        .await;
        assert_eq!(r, ScopeCheck::Allow);
    }

    #[tokio::test]
    async fn reads_and_deletes_not_scoped() {
        for m in ["GET", "DELETE"] {
            let r = evaluate(
                "www.googleapis.com",
                m,
                "/drive/v3/files/abc",
                None,
                &allowed(&["good"]),
                no_lookup(),
            )
            .await;
            assert_eq!(r, ScopeCheck::Allow);
        }
    }

    #[tokio::test]
    async fn cycle_in_parents_terminates() {
        // a → b → a (cycle). Should terminate and deny (no allowed ancestor).
        let map = HashMap::from([("a", vec!["b"]), ("b", vec!["a"])]);
        let r = evaluate(
            "www.googleapis.com",
            "PATCH",
            "/drive/v3/files/x?addParents=a",
            None,
            &allowed(&["good"]),
            resolver(map),
        )
        .await;
        assert!(matches!(r, ScopeCheck::Deny(_)));
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
