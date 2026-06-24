import type { AppDefinition } from "./types";

const ZOOM_AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

/**
 * Zoom user-level OAuth connector ("Zoom User").
 *
 * Distinct from the Server-to-Server connector (`zoom`, "Zoom S2S"): Zoom only
 * grants the `docs:*` / Zoom Docs scopes to **General** (user-level OAuth) apps,
 * so reading Zoom Docs / "My Notes" content requires this authorization_code
 * flow — S2S tokens cannot carry those scopes.
 *
 * Both connectors share the `api.zoom.us` host (see apps.rs). The surfaces
 * overlap, so the gateway disambiguates by credential identity via the
 * `x-onecli-connection-id` header, not by path. Refresh uses the standard
 * refresh_token flow (Zoom rotates the refresh token on every refresh — the
 * gateway persists the rotated token, see connect.rs).
 */
export const zoomUser: AppDefinition = {
  id: "zoom-user",
  name: "Zoom User",
  icon: "/icons/zoom.svg",
  description:
    "Zoom Docs and My Notes via user-level OAuth (General app). Use Zoom S2S for meetings, recordings, and summaries.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "user:read:user",
      "docs:read:file",
      "docs:read:list_children",
      "docs:read:export",
    ],
    permissions: [
      {
        scope: "user:read:user",
        name: "User profile",
        description: "View your name and email (for the connection label)",
        access: "read",
      },
      {
        scope: "docs:read:file",
        name: "Read doc metadata",
        description: "View Zoom Docs / My Notes file details",
        access: "read",
      },
      {
        scope: "docs:read:list_children",
        name: "List docs",
        description: "Enumerate docs and folders in a Zoom Docs folder",
        access: "read",
      },
      {
        scope: "docs:read:export",
        name: "Export doc content",
        description: "Read and export Zoom Docs / My Notes content",
        access: "read",
      },
      {
        scope: "docs:write:export",
        name: "Create export jobs",
        description: "Start export jobs to retrieve doc content",
        access: "write",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      if (!appCredentials.clientId) {
        throw new Error("Zoom User OAuth client ID not configured");
      }
      const url = new URL(ZOOM_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      // Zoom honours the optional scope param for granular-scope apps.
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
      }
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      if (callbackParams.error) {
        throw new Error(
          `Zoom authorization error: ${callbackParams.error} — ${callbackParams.error_description ?? "no description"}`,
        );
      }
      if (!callbackParams.code) {
        throw new Error("Zoom callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Zoom User OAuth credentials not configured");
      }

      // Zoom requires client credentials via HTTP Basic auth on the token call.
      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch(ZOOM_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text().catch(() => "");
        throw new Error(
          `Zoom token exchange failed (${tokenRes.status}): ${errBody || tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
        error?: string;
        reason?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          tokenData.reason ??
            tokenData.error ??
            "Failed to exchange code for token",
        );
      }

      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      const scopes = tokenData.scope?.split(/[ ,]+/).filter(Boolean) ?? [];

      // Resolve the account owner for the connection label. Non-fatal.
      const metadata: Record<string, unknown> = {};
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
          metadata.name = name || me.email;
          metadata.username = me.email;
          metadata.email = me.email;
        }
      } catch {
        // Non-fatal — metadata is optional
      }

      return { credentials, scopes, metadata };
    },
  },
  labelHint: 'e.g. "personal", "work"',
  available: true,
  configurable: {
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        description: "From your General (OAuth) app at marketplace.zoom.us.",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxx",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "ZOOM_USER_CLIENT_ID",
      clientSecret: "ZOOM_USER_CLIENT_SECRET",
    },
  },
};
