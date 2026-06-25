import type { AppPermissionDefinition } from "./types";

/**
 * Zoom Docs / "My Notes" routes, reachable only via user-level OAuth ("Zoom User").
 * The Docs API is file-tree oriented (keyed by fileId) — there is no
 * `/v2/docs/users/{id}/root` endpoint. Enumerate via a folder's children, then
 * read content through the async export flow.
 */
export const zoomUserPermissions: AppPermissionDefinition = {
  provider: "zoom-user",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_doc",
          name: "Get doc",
          description: "Retrieve a Zoom Docs / My Notes file's metadata",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/docs/files/*",
          method: "GET",
        },
        {
          id: "list_doc_children",
          name: "List doc children",
          description: "List docs and folders contained in a folder",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/docs/files/*/children",
          method: "GET",
        },
        {
          id: "get_export_status",
          name: "Get export status",
          description: "Poll an export job and retrieve its result",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/docs/exports/*/status",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_export",
          name: "Export doc content",
          description: "Start an export job to read a doc's content",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/docs/exports",
          method: "POST",
        },
      ],
    },
  ],
};
