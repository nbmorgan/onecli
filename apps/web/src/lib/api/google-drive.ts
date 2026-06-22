import { apiGet } from "./client";
import type { GoogleDriveFolder } from "./types";

/** Folder children of `parentId` ("root" = top level) for a Drive connection. */
export const folders = (connectionId: string, parentId = "root") =>
  apiGet<GoogleDriveFolder[]>(
    `/v1/apps/google-drive/folders?connectionId=${encodeURIComponent(
      connectionId,
    )}&parentId=${encodeURIComponent(parentId)}`,
  );

/** Search folders by name across the connection's Drive(s). */
export const searchFolders = (connectionId: string, query: string) =>
  apiGet<GoogleDriveFolder[]>(
    `/v1/apps/google-drive/search-folders?connectionId=${encodeURIComponent(
      connectionId,
    )}&q=${encodeURIComponent(query)}`,
  );
