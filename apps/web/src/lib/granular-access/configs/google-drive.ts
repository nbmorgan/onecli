import { Folder } from "lucide-react";
import type { GranularAccessConfig } from "../types";
import { GoogleDriveFolderPicker } from "./google-drive-folder-picker";

/**
 * Self-hosted note: upstream gates the granular folder picker behind the cloud
 * build (Dropbox ships no PolicyDialogContent, so OSS shows a "Team" upsell).
 * This fork wires a real picker + backend folder browser so folder scoping
 * works in self-hosted. The chosen folder ids round-trip through the agent's
 * connection sessionPolicy and are enforced by the OSS gateway.
 */
export const googleDriveConfig: GranularAccessConfig = {
  // Folders are browsed live in the dialog; always available once connected.
  isSupported: () => true,
  // Items come from the live browser, not connect-time metadata.
  getItems: () => [],
  buildPolicy: (folderIds) =>
    folderIds.length > 0
      ? { folders: folderIds.map((id) => ({ id, name: id })) }
      : {},
  getSelectedItems: (policy) => {
    const folders = (policy.folders as unknown[]) ?? [];
    return folders
      .map((f) =>
        typeof f === "string"
          ? f
          : f &&
              typeof f === "object" &&
              typeof (f as { id?: unknown }).id === "string"
            ? (f as { id: string }).id
            : null,
      )
      .filter((id): id is string => id !== null);
  },
  itemLabel: { singular: "folder", plural: "folders" },
  Icon: Folder,
  PolicyDialogContent: GoogleDriveFolderPicker,
  formatSummary: (policy) => {
    const folders = (policy?.folders as unknown[] | undefined) ?? [];
    if (folders.length === 0) return "All folders";
    const names = folders
      .map((f) =>
        f &&
        typeof f === "object" &&
        typeof (f as { name?: unknown }).name === "string"
          ? (f as { name: string }).name
          : null,
      )
      .filter((n): n is string => n !== null);
    if (names.length > 0 && names.length <= 2) return names.join(", ");
    return `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`;
  },
};
