/**
 * Tool-intrinsic request conditions, stored on the rule's `conditions` column
 * and evaluated by the gateway (`apps/gateway/src/condition_match.rs`). This is
 * how a single multiplexed endpoint is split into distinct logical operations —
 * e.g. a Google Drive file *move* (`PATCH …?addParents=`) vs a generic metadata
 * update, both of which hit `PATCH /drive/v3/files/{id}`.
 *
 * All present clauses must hold (logical AND):
 * - `queryAll` / `queryAny` / `queryAbsent`: query-param keys present / present /
 *   absent.
 * - `bodyJson`: every field equals the given value (e.g. folder mimeType).
 * - `bodyJsonNot`: at least one field differs/absent (generic create, i.e. not a
 *   folder create).
 *
 * Serialized to the snake_case keys the gateway matcher expects via
 * {@link serializeToolConditions}.
 */
export interface ToolConditions {
  queryAll?: string[];
  queryAny?: string[];
  queryAbsent?: string[];
  bodyJson?: Record<string, string>;
  bodyJsonNot?: Record<string, string>;
}

export interface AppTool {
  id: string;
  name: string;
  description: string;
  hostPattern: string;
  pathPattern: string;
  aliasPatterns?: string[];
  method?: string;
  methods?: string[];
  conditions?: ToolConditions;
}

/**
 * Convert {@link ToolConditions} to the JSON shape the gateway matcher reads
 * (`query_all`, `query_any`, `query_absent`, `body_json`, `body_json_not`).
 * Returns `undefined` when no clauses are set.
 */
export const serializeToolConditions = (
  conditions: ToolConditions | undefined,
): Record<string, unknown> | undefined => {
  if (!conditions) return undefined;
  const out: Record<string, unknown> = {};
  if (conditions.queryAll?.length) out.query_all = conditions.queryAll;
  if (conditions.queryAny?.length) out.query_any = conditions.queryAny;
  if (conditions.queryAbsent?.length) out.query_absent = conditions.queryAbsent;
  if (conditions.bodyJson && Object.keys(conditions.bodyJson).length)
    out.body_json = conditions.bodyJson;
  if (conditions.bodyJsonNot && Object.keys(conditions.bodyJsonNot).length)
    out.body_json_not = conditions.bodyJsonNot;
  return Object.keys(out).length > 0 ? out : undefined;
};

export interface AppToolGroup {
  category: "read" | "write";
  tools: AppTool[];
  wildcard?: AppTool;
}

export const allGroupTools = (group: AppToolGroup): AppTool[] => [
  ...(group.wildcard ? [group.wildcard] : []),
  ...group.tools,
];

export type AppPermissionLevel = "allow" | "manual_approval" | "block";

export const mapRuleActionToPermission = (
  action: string,
): AppPermissionLevel =>
  action === "block"
    ? "block"
    : action === "allow"
      ? "allow"
      : "manual_approval";

export interface AppPermissionDefinition {
  provider: string;
  groups: AppToolGroup[];
}
