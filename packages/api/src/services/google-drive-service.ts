import { db } from "@onecli/db";
import { ServiceError } from "./errors";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere } from "./resource-scope";
import { getCrypto } from "../providers/crypto";
import { getApp } from "../apps/registry";
import { resolveAppCredentials } from "../apps/resolve-credentials";
import { refreshGoogleAccessToken } from "../apps/oauth/google";

const PROVIDER = "google-drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleDriveFolder {
  id: string;
  name: string;
  /** Parent folder ids, when returned by Drive. */
  parents?: string[];
}

interface StoredGoogleCredentials {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
}

/**
 * Return a currently-valid access token for a Google Drive connection,
 * refreshing and persisting it when the stored token is expired (or about to
 * expire). Mirrors what the Rust gateway does at proxy time, but for the
 * server-side folder browser which talks to Drive directly.
 */
export const getValidDriveAccessToken = async (
  scope: ResourceScope,
  connectionId: string,
): Promise<string> => {
  const connection = await db.appConnection.findFirst({
    where: { id: connectionId, provider: PROVIDER, ...scopeWhere(scope) },
    select: { id: true, credentials: true, projectId: true },
  });
  if (!connection?.credentials) {
    throw new ServiceError("NOT_FOUND", "Google Drive connection not found");
  }

  const creds = JSON.parse(
    await getCrypto().decrypt(connection.credentials),
  ) as StoredGoogleCredentials;

  const now = Math.floor(Date.now() / 1000);
  const stillValid =
    creds.access_token && (!creds.expires_at || creds.expires_at > now + 60);
  if (stillValid) return creds.access_token!;

  if (!creds.refresh_token) {
    // No way to refresh; fall back to the (possibly expired) token rather than
    // hard-failing, so a freshly-connected account still works.
    if (creds.access_token) return creds.access_token;
    throw new ServiceError(
      "BAD_REQUEST",
      "Google Drive connection has no usable token; reconnect the account",
    );
  }

  const appDef = getApp(PROVIDER);
  if (!appDef) throw new ServiceError("NOT_FOUND", "Google Drive app missing");
  const resolved = await resolveAppCredentials(
    connection.projectId ?? scope.projectId ?? "",
    appDef,
  );
  if (!resolved) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Google OAuth credentials are not configured for this project",
    );
  }

  const refreshed = await refreshGoogleAccessToken({
    clientId: resolved.values.clientId!,
    clientSecret: resolved.values.clientSecret!,
    refreshToken: creds.refresh_token,
  });

  const updated: StoredGoogleCredentials = {
    ...creds,
    access_token: refreshed.accessToken,
    expires_at: refreshed.expiresAt,
  };
  await db.appConnection.update({
    where: { id: connection.id },
    data: { credentials: await getCrypto().encrypt(JSON.stringify(updated)) },
  });

  return refreshed.accessToken;
};

interface DriveFilesResponse {
  files?: { id?: string; name?: string; parents?: string[] }[];
}

const callDriveFolderList = async (
  token: string,
  query: string,
): Promise<GoogleDriveFolder[]> => {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", query);
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("orderBy", "name");
  url.searchParams.set("fields", "files(id,name,parents)");
  // Include shared drives so org folders are browsable.
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("corpora", "allDrives");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ServiceError(
      res.status === 401 || res.status === 403 ? "BAD_REQUEST" : "BAD_REQUEST",
      `Google Drive API error (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as DriveFilesResponse;
  return (data.files ?? [])
    .filter((f): f is { id: string; name: string; parents?: string[] } =>
      Boolean(f.id && f.name),
    )
    .map((f) => ({ id: f.id, name: f.name, parents: f.parents }));
};

/** Escape a value for use inside a Drive `q` string literal. */
const escapeDriveQueryValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * List the folder children of `parentId` ("root" for the top level) for a
 * Google Drive connection. Folders only.
 */
export const listDriveFolders = async (
  scope: ResourceScope,
  connectionId: string,
  parentId = "root",
): Promise<GoogleDriveFolder[]> => {
  const token = await getValidDriveAccessToken(scope, connectionId);
  const parent = escapeDriveQueryValue(parentId);
  const query = `mimeType = '${FOLDER_MIME}' and trashed = false and '${parent}' in parents`;
  return callDriveFolderList(token, query);
};

/**
 * Search folders by name across the connection's Drive(s). Folders only.
 */
export const searchDriveFolders = async (
  scope: ResourceScope,
  connectionId: string,
  search: string,
): Promise<GoogleDriveFolder[]> => {
  const token = await getValidDriveAccessToken(scope, connectionId);
  const term = escapeDriveQueryValue(search.trim());
  const query =
    term.length > 0
      ? `mimeType = '${FOLDER_MIME}' and trashed = false and name contains '${term}'`
      : `mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`;
  return callDriveFolderList(token, query);
};
