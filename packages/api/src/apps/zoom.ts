import type { AppDefinition, OAuthExchangeResult } from "./types";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

/**
 * Exchange Server-to-Server OAuth credentials for an access token.
 *
 * Zoom S2S apps use the `account_credentials` grant: client_id/client_secret
 * via Basic auth plus the target account_id. Tokens expire after one hour
 * with no refresh token — the gateway re-exchanges autonomously using the
 * stored credentials (cred type "zoom_s2s", see gateway apps.rs).
 */
const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { accountId, clientId, clientSecret } = fields;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Account ID, Client ID, and Client Secret are required");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const body = new URLSearchParams({
    grant_type: "account_credentials",
    account_id: accountId,
  });

  const tokenRes = await fetch(ZOOM_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => "");
    throw new Error(
      `Zoom token exchange failed (${tokenRes.status}): ${errBody || tokenRes.statusText}`,
    );
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    reason?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new Error(
      tokenData.reason ?? tokenData.error ?? "Failed to obtain access token",
    );
  }

  const expiresAt =
    Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600);

  const credentials: Record<string, unknown> = {
    type: "zoom_s2s",
    access_token: tokenData.access_token,
    expires_at: expiresAt,
    account_id: accountId,
    client_id: clientId,
    client_secret: clientSecret,
  };

  // Resolve account owner info for the connection label. Non-fatal — the
  // users:read scope may not be granted on the S2S app.
  let metadata: Record<string, unknown> | undefined;
  try {
    const meRes = await fetch("https://api.zoom.us/v2/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        email?: string;
        display_name?: string;
        first_name?: string;
        last_name?: string;
      };
      const name =
        me.display_name ??
        [me.first_name, me.last_name].filter(Boolean).join(" ");
      metadata = {
        name: name || me.email,
        username: me.email,
        email: me.email,
      };
    }
  } catch {
    // Non-fatal — metadata is optional
  }

  const scopes = tokenData.scope?.split(/[ ,]+/).filter(Boolean) ?? [];

  return { credentials, scopes, metadata };
};

export const zoom: AppDefinition = {
  id: "zoom",
  name: "Zoom S2S",
  icon: "/icons/zoom.svg",
  description:
    "Meetings, webinars, users, recordings, and AI Companion summaries via Server-to-Server OAuth. Use Zoom User for Docs / My Notes.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "accountId",
        label: "Account ID",
        description:
          "From your Server-to-Server OAuth app at marketplace.zoom.us.",
        placeholder: "AbCdEfGhIjKlMnOpQrStUv",
        secret: false,
      },
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxx",
        secret: false,
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        secret: true,
      },
    ],
    exchangeCredentials,
  },
  labelHint: 'e.g. "homelab", "work"',
  available: true,
};
