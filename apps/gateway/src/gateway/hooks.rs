//! Forward hooks — extension points for the request forwarding pipeline.
//!
//! OSS version: all hooks are no-ops. The cloud build swaps this module
//! via `#[path = "cloud/hooks.rs"]` to add cloud-specific telemetry.

use std::pin::Pin;

use futures_util::TryStreamExt;
use http_body_util::{Either, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::Response;

use super::mitm::ResolvedRules;
use super::ProxyContext;

// ── Shared types ────────────────────────────────────────────────────────

pub(crate) type BodyStream =
    Pin<Box<dyn futures_util::Stream<Item = Result<Frame<Bytes>, reqwest::Error>> + Send>>;

pub(crate) type ForwardResponseBody = Either<Full<Bytes>, StreamBody<BodyStream>>;

/// Common telemetry fields for a proxied request, passed from forward to hooks.
pub(crate) struct RequestMeta {
    pub org_id: String,
    pub project_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub provider: String,
    pub status: u16,
    pub latency_ms: u32,
    pub injection_count: u16,
    pub timestamp: String,
    pub injected: bool,
    pub connection_label: Option<String>,
    pub existing_log_id: Option<String>,
    pub decision: Option<crate::telemetry_core::RequestDecision>,
}

// ── Hooks ───────────────────────────────────────────────────────────────

pub(crate) fn prepare_request(
    _rules: &ResolvedRules,
    _host: &str,
    _path: &str,
    _headers: &mut hyper::HeaderMap,
) {
}

/// Whether the request guard needs the buffered request body to make a
/// decision. In this OSS fork the only guard is Google Drive folder scoping,
/// which needs the body to read a create's target folder (`parents`).
pub(crate) fn needs_request_body(
    rules: &ResolvedRules,
    host: &str,
    method: &str,
    path: &str,
) -> bool {
    rules.session_policy.is_some() && super::drive_scope::needs_body(host, method, path)
}

/// Request guard. OSS fork: enforce Google Drive folder scope from the
/// connection's `session_policy` before forwarding. A request that would write
/// outside the allowed folders is denied with a 403, matching the policy-block
/// response shape. Everything else passes through.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pre_forward(
    rules: &ResolvedRules,
    proxy_ctx: &ProxyContext,
    host: &str,
    cache: &dyn crate::cache::CacheStore,
    _pool: &sqlx::PgPool,
    _injection_count: usize,
    method: &str,
    path: &str,
    headers: &hyper::HeaderMap,
    body: Option<&[u8]>,
) -> Option<Response<ForwardResponseBody>> {
    let session_policy = rules.session_policy.as_ref()?;
    let allowed = super::drive_scope::allowed_folder_ids(session_policy);
    if allowed.is_empty() {
        return None;
    }

    // Bearer token already injected by `apply_injections`; used to resolve a
    // target folder's ancestors (subtree scope). No token → resolver fails
    // closed and out-of-scope writes are denied.
    let token = bearer_token(headers);
    let resolver = move |id: String| {
        let token = token.clone();
        Box::pin(async move {
            match token.as_deref() {
                Some(t) => super::drive_scope::resolve_parents(cache, t, &id).await,
                None => None,
            }
        })
            as std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<String>>> + Send + '_>>
    };

    if let super::drive_scope::ScopeCheck::Deny(reason) =
        super::drive_scope::evaluate(host, method, path, body, &allowed, resolver).await
    {
        tracing::warn!(
            method = %method, host = %host, path = %path, reason = %reason,
            "BLOCKED by Google Drive folder scope"
        );
        return Some(super::response::json(
            hyper::StatusCode::FORBIDDEN,
            serde_json::json!({
                "error": "blocked_by_folder_scope",
                "message": format!(
                    "Blocked by OneCLI folder scope: {reason}. \
                     Update the connection's allowed folders in your OneCLI dashboard."
                ),
                "method": method,
                "path": path,
                "project_id": proxy_ctx.project_id,
            }),
        ));
    }
    None
}

/// Extract the bearer token from an `Authorization: Bearer <token>` header.
fn bearer_token(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

/// Request-body transform hook. OSS: passthrough. The cloud build injects a
/// claim note into LLM requests for unclaimed (partner-created) orgs.
pub(crate) async fn prepare_request_body(
    _rules: &ResolvedRules,
    _host: &str,
    body: reqwest::Body,
) -> reqwest::Body {
    body
}

pub(crate) fn track_and_wrap(
    meta: RequestMeta,
    _rules: &ResolvedRules,
    _resp_headers: &hyper::HeaderMap,
    stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
) -> BodyStream {
    crate::telemetry::on_request(crate::telemetry::RequestEvent {
        org_id: meta.org_id,
        project_id: meta.project_id,
        agent_id: meta.agent_id,
        agent_name: meta.agent_name,
        method: meta.method,
        host: meta.host,
        path: meta.path,
        provider: meta.provider,
        status: meta.status,
        latency_ms: meta.latency_ms,
        injection_count: meta.injection_count,
        timestamp: meta.timestamp,
        injected: meta.injected,
        decision: meta
            .decision
            .unwrap_or(crate::telemetry_core::RequestDecision::Allowed),
        connection_label: meta.connection_label,
        existing_log_id: meta.existing_log_id,
        log_id: None,
        budget_charge: None,
    });
    Box::pin(stream.map_ok(Frame::data))
}
