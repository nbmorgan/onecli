import type { AppPermissionDefinition } from "./types";

export const googleDrivePermissions: AppPermissionDefinition = {
  provider: "google-drive",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_files",
          name: "List files",
          description: "List files in Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "GET",
        },
        {
          id: "get_file",
          name: "Get file",
          description: "Download a file from Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "GET",
        },
        {
          id: "get_file_metadata",
          name: "Get file metadata",
          description: "Retrieve metadata for a specific file",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "GET",
        },
        {
          id: "search_files",
          name: "Search files",
          description: "Search for files matching a query",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_file",
          name: "Create file",
          description: "Upload a new file to Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          aliasPatterns: ["/upload/drive/v3/files"],
          method: "POST",
          // Folder creates share this endpoint; exclude them so a "create file"
          // rule does not also govern "create folder".
          conditions: {
            bodyJsonNot: { mimeType: "application/vnd.google-apps.folder" },
          },
        },
        {
          id: "create_folder",
          name: "Create folder",
          description: "Create a new folder in Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "POST",
          // A folder is just a file with the folder mimeType in the JSON body.
          conditions: {
            bodyJson: { mimeType: "application/vnd.google-apps.folder" },
          },
        },
        {
          id: "update_file",
          name: "Update file",
          description:
            "Edit an existing file's content or metadata (not folder moves)",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          aliasPatterns: ["/upload/drive/v3/files/*"],
          method: "PATCH",
          // Parent changes (moves) hit the same PATCH; exclude them so a generic
          // update rule is separable from move_file.
          conditions: { queryAbsent: ["addParents", "removeParents"] },
        },
        {
          id: "move_file",
          name: "Move file or folder",
          description:
            "Move a file or folder between folders by changing its parents",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "PATCH",
          // A move is a PATCH that adds and/or removes parents.
          conditions: { queryAny: ["addParents", "removeParents"] },
        },
        {
          id: "delete_file",
          name: "Delete file or folder",
          description: "Delete a file or folder from Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "DELETE",
          // NOTE: Drive deletes a file and a folder via the identical request
          // (DELETE /drive/v3/files/{id}); the item's type is only known from a
          // prior metadata lookup, which the gateway does not perform. Delete
          // therefore cannot be split into file-only vs folder-only at the
          // policy layer — this one rule governs both.
        },
        {
          id: "share_file",
          name: "Share file or folder",
          description: "Create a permission to share a file or folder",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*/permissions",
          method: "POST",
        },
      ],
    },
  ],
};
