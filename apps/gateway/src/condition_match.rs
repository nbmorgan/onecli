//! Request-condition matching for policy rules.
//!
//! A [`PolicyRule`] matches a request on method + path (see `policy.rs`). When a
//! rule also carries `conditions_raw`, this module decides whether those extra
//! conditions hold for the concrete request. This is what lets a single upstream
//! endpoint be split into distinct logical operations.
//!
//! ## Self-hosted note
//!
//! Upstream ships this file as a no-op stub: real condition matching is a
//! cloud-only feature whose implementation lives in the closed-source cloud
//! overlay (`cloud/condition_match.rs` is only a `cargo fmt` placeholder, and the
//! `cloud` Cargo feature is never enabled by `docker/Dockerfile`). This fork
//! implements condition matching directly in the OSS build so self-hosted
//! deployments get the same behavior without the cloud overlay. If you are
//! following the self-hosted path, this module — together with the `conditions`
//! column already present in the schema — is what makes per-request rule
//! conditions (e.g. Google Drive folder moves) enforceable.
//!
//! ## Why this exists
//!
//! Google Drive multiplexes every operation onto `/drive/v3/files[/{id}]`. A file
//! *move* is `PATCH …?addParents=…&removeParents=…` and a *folder create* is
//! `POST …` with a JSON body `{"mimeType":"application/vnd.google-apps.folder"}`.
//! Method + path alone cannot tell these apart from a generic update or file
//! create, because `path_matches` deliberately strips the query string. Rule
//! conditions recover that signal: query-param presence and JSON body fields.
//!
//! ## Condition schema (`conditions_raw`)
//!
//! A JSON object; every clause present must hold (logical AND):
//!
//! ```json
//! {
//!   "query_all":    ["addParents"],                 // all keys present in query
//!   "query_any":    ["addParents", "removeParents"],// at least one present
//!   "query_absent": ["addParents", "removeParents"],// none present
//!   "body_json":    { "mimeType": "application/vnd.google-apps.folder" }
//! }
//! ```
//!
//! A rule with no conditions (`conditions_raw = None`) always matches, so existing
//! rules behave exactly as before.

use serde_json::Value;

use crate::policy::PolicyRule;

/// Does any rule carry a condition that needs the request body buffered?
///
/// Query conditions read the path (always available), so only a `body_json`
/// clause forces buffering. In the common case (no body conditions) this returns
/// `false` and the body is streamed straight through with zero overhead.
pub(crate) fn needs_body_buffer(rules: &[PolicyRule]) -> bool {
    rules.iter().any(|r| {
        r.conditions_raw
            .as_ref()
            .and_then(|c| c.get("body_json"))
            .is_some()
    })
}

/// Buffer the request body when condition matching needs it.
///
/// Callers gate this behind [`needs_body_buffer`], so we only reach here for a
/// request that a `body_json` condition must inspect. The returned bytes are what
/// [`matches`] reads; the second element is the body to forward upstream.
pub(crate) async fn prepare_body(
    body: hyper::body::Incoming,
    _method: &str,
    _url: &str,
) -> anyhow::Result<(Option<Vec<u8>>, reqwest::Body)> {
    use http_body_util::BodyExt;
    let bytes = body.collect().await?.to_bytes();
    let buf = bytes.to_vec();
    Ok((Some(buf), reqwest::Body::from(bytes)))
}

/// Evaluate a rule's `conditions_raw` against the concrete request.
///
/// `path` is the request path *including* its query string (e.g.
/// `/drive/v3/files/abc?addParents=xyz`). `body` is the buffered request body
/// when available (see [`needs_body_buffer`]).
///
/// Returns `true` when the rule has no conditions or all its conditions hold.
/// Unknown condition keys are ignored (treated as satisfied) so the rule degrades
/// to plain method+path matching rather than silently failing open or closed.
pub(crate) fn matches(rule: &PolicyRule, path: &str, body: Option<&[u8]>) -> bool {
    let Some(conditions) = rule.conditions_raw.as_ref() else {
        return true;
    };
    let Some(obj) = conditions.as_object() else {
        // Non-object conditions are malformed; preserve plain method+path match.
        return true;
    };

    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");

    if let Some(keys) = obj.get("query_all").and_then(Value::as_array) {
        if !keys
            .iter()
            .filter_map(Value::as_str)
            .all(|k| query_has_key(query, k))
        {
            return false;
        }
    }

    if let Some(keys) = obj.get("query_any").and_then(Value::as_array) {
        if !keys
            .iter()
            .filter_map(Value::as_str)
            .any(|k| query_has_key(query, k))
        {
            return false;
        }
    }

    if let Some(keys) = obj.get("query_absent").and_then(Value::as_array) {
        if keys
            .iter()
            .filter_map(Value::as_str)
            .any(|k| query_has_key(query, k))
        {
            return false;
        }
    }

    if let Some(fields) = obj.get("body_json").and_then(Value::as_object) {
        let parsed: Option<Value> = body.and_then(|b| serde_json::from_slice(b).ok());
        let Some(Value::Object(body_obj)) = parsed else {
            // Body absent or not a JSON object → a body_json clause cannot hold.
            return false;
        };
        for (field, expected) in fields {
            if body_obj.get(field) != Some(expected) {
                return false;
            }
        }
    }

    true
}

/// Is `key` present as a parameter in the `&`-separated query string?
fn query_has_key(query: &str, key: &str) -> bool {
    query.split('&').any(|pair| {
        let name = pair.split_once('=').map(|(n, _)| n).unwrap_or(pair);
        name == key
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{PolicyAction, PolicyRule};
    use serde_json::json;

    fn rule_with(conditions: Option<Value>) -> PolicyRule {
        PolicyRule {
            name: "test".to_string(),
            path_pattern: "/drive/v3/files/*".to_string(),
            method: Some("PATCH".to_string()),
            action: PolicyAction::Block,
            conditions_raw: conditions,
        }
    }

    #[test]
    fn no_conditions_always_matches() {
        let rule = rule_with(None);
        assert!(matches(&rule, "/drive/v3/files/abc", None));
        assert!(matches(&rule, "/drive/v3/files/abc?addParents=x", None));
    }

    #[test]
    fn malformed_conditions_match() {
        let rule = rule_with(Some(json!("not-an-object")));
        assert!(matches(&rule, "/drive/v3/files/abc", None));
    }

    #[test]
    fn unknown_condition_keys_ignored() {
        let rule = rule_with(Some(json!({ "future_key": 123 })));
        assert!(matches(&rule, "/drive/v3/files/abc", None));
    }

    #[test]
    fn query_any_matches_move() {
        let rule = rule_with(Some(json!({ "query_any": ["addParents", "removeParents"] })));
        assert!(matches(
            &rule,
            "/drive/v3/files/abc?addParents=folder1",
            None
        ));
        assert!(matches(
            &rule,
            "/drive/v3/files/abc?removeParents=folder2&supportsAllDrives=true",
            None
        ));
    }

    #[test]
    fn query_any_does_not_match_plain_update() {
        let rule = rule_with(Some(json!({ "query_any": ["addParents", "removeParents"] })));
        assert!(!matches(&rule, "/drive/v3/files/abc", None));
        assert!(!matches(
            &rule,
            "/drive/v3/files/abc?fields=id%2Cname",
            None
        ));
    }

    #[test]
    fn query_all_requires_every_key() {
        let rule = rule_with(Some(json!({ "query_all": ["addParents", "removeParents"] })));
        assert!(matches(
            &rule,
            "/drive/v3/files/abc?addParents=x&removeParents=y",
            None
        ));
        assert!(!matches(&rule, "/drive/v3/files/abc?addParents=x", None));
    }

    #[test]
    fn query_absent_blocks_when_param_present() {
        let rule = rule_with(Some(json!({ "query_absent": ["addParents", "removeParents"] })));
        assert!(matches(&rule, "/drive/v3/files/abc?fields=id", None));
        assert!(!matches(&rule, "/drive/v3/files/abc?addParents=x", None));
    }

    #[test]
    fn body_json_matches_folder_mimetype() {
        let rule = rule_with(Some(
            json!({ "body_json": { "mimeType": "application/vnd.google-apps.folder" } }),
        ));
        let folder = br#"{"name":"New Folder","mimeType":"application/vnd.google-apps.folder"}"#;
        let file = br#"{"name":"doc.txt","mimeType":"text/plain"}"#;
        assert!(matches(&rule, "/drive/v3/files", Some(folder)));
        assert!(!matches(&rule, "/drive/v3/files", Some(file)));
    }

    #[test]
    fn body_json_without_body_does_not_match() {
        let rule = rule_with(Some(
            json!({ "body_json": { "mimeType": "application/vnd.google-apps.folder" } }),
        ));
        assert!(!matches(&rule, "/drive/v3/files", None));
        assert!(!matches(&rule, "/drive/v3/files", Some(b"not json")));
    }

    #[test]
    fn combined_clauses_and_together() {
        let rule = rule_with(Some(json!({
            "query_any": ["addParents"],
            "query_absent": ["trashed"],
        })));
        assert!(matches(&rule, "/drive/v3/files/abc?addParents=x", None));
        assert!(!matches(
            &rule,
            "/drive/v3/files/abc?addParents=x&trashed=true",
            None
        ));
    }

    #[test]
    fn needs_body_buffer_only_for_body_conditions() {
        let query_rule = rule_with(Some(json!({ "query_any": ["addParents"] })));
        let body_rule = rule_with(Some(json!({ "body_json": { "mimeType": "x" } })));
        let plain_rule = rule_with(None);
        assert!(!needs_body_buffer(&[query_rule.clone()]));
        assert!(!needs_body_buffer(&[plain_rule]));
        assert!(needs_body_buffer(&[body_rule.clone()]));
        assert!(needs_body_buffer(&[query_rule, body_rule]));
    }
}
