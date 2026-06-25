/**
 * The application build version shown in the dashboard (Overview + Settings →
 * Instance) and reported by `/api/health`.
 *
 * Injected at build time as `NEXT_PUBLIC_APP_VERSION` (see `next.config.js`):
 * resolved from `ONECLI_VERSION` / `APP_VERSION` when set (e.g. a custom image
 * tag), otherwise the monorepo `package.json` version. Falls back to `"dev"`
 * for local/unbuilt runs.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
