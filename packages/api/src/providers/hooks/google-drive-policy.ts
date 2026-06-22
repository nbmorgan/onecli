import { ServiceError } from "../../services/errors";

/**
 * Canonical Google Drive granular-access policy shape:
 *
 * ```json
 * { "folders": [ { "id": "16B14v…", "name": "Blaine & Fritz" } ] }
 * ```
 *
 * For robustness the validator also accepts `{ "folderIds": ["…"] }` and a bare
 * `{ "folders": ["…"] }` (ids only). An empty/absent policy means "all folders"
 * (no restriction). The Rust gateway reads folder ids from this same shape when
 * enforcing folder scope (see `apps/gateway/src/gateway/hooks.rs`).
 */
export interface DriveFolderScope {
  id: string;
  name?: string;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** Extract the scoped folder ids from a Drive session policy, or [] for none. */
export const driveScopedFolderIds = (
  policy: Record<string, unknown> | null | undefined,
): string[] => {
  if (!policy) return [];
  const { folders, folderIds } = policy as {
    folders?: unknown;
    folderIds?: unknown;
  };
  if (Array.isArray(folderIds)) return folderIds.filter(isNonEmptyString);
  if (Array.isArray(folders)) {
    return folders
      .map((f) =>
        isNonEmptyString(f)
          ? f
          : f &&
              typeof f === "object" &&
              isNonEmptyString((f as DriveFolderScope).id)
            ? (f as DriveFolderScope).id
            : null,
      )
      .filter(isNonEmptyString);
  }
  return [];
};

/**
 * Validate the shape of a Google Drive granular-access policy. Throws a
 * `ServiceError("BAD_REQUEST")` on malformed input. Shape-only: it does not
 * live-verify that the folders exist (that would require a network round-trip
 * per save), but it guarantees the gateway receives well-formed folder ids.
 */
export const validateGoogleDrivePolicy = (
  policy: Record<string, unknown>,
): void => {
  // Empty policy = no restriction.
  if (Object.keys(policy).length === 0) return;

  const hasFolders = "folders" in policy;
  const hasFolderIds = "folderIds" in policy;
  if (!hasFolders && !hasFolderIds) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Google Drive policy must specify `folders` or `folderIds`",
    );
  }

  if (hasFolderIds && !Array.isArray(policy.folderIds)) {
    throw new ServiceError("BAD_REQUEST", "`folderIds` must be an array");
  }
  if (hasFolders && !Array.isArray(policy.folders)) {
    throw new ServiceError("BAD_REQUEST", "`folders` must be an array");
  }

  if (Array.isArray(policy.folders)) {
    for (const f of policy.folders) {
      const id =
        isNonEmptyString(f) || !f || typeof f !== "object"
          ? f
          : (f as DriveFolderScope).id;
      if (!isNonEmptyString(id)) {
        throw new ServiceError(
          "BAD_REQUEST",
          "Each Drive folder must be a non-empty id or { id } object",
        );
      }
    }
  }
  if (Array.isArray(policy.folderIds)) {
    for (const id of policy.folderIds) {
      if (!isNonEmptyString(id)) {
        throw new ServiceError(
          "BAD_REQUEST",
          "Each Drive folder id must be a non-empty string",
        );
      }
    }
  }

  if (driveScopedFolderIds(policy).length === 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Google Drive policy lists no valid folder ids",
    );
  }
};
