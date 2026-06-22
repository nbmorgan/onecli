import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./oauth/google";

export const googleDrive: AppDefinition = {
  id: "google-drive",
  name: "Google Drive",
  icon: "/icons/google-drive.svg",
  description: "Read, create, and manage files and folders.",
  connectionMethod: {
    type: "oauth",
    // Self-hosted note: the write scope is the full `drive` scope, not the
    // narrower `drive.file`. `drive.file` only grants access to files the app
    // itself created or opened, so it cannot move, organize, or edit pre-existing
    // files/folders — which is exactly what folder workflows (e.g. "move this
    // existing doc into folder X") require. The copy below is written to match
    // this broader grant so the consent screen is truthful. If you want a
    // narrower posture, swap back to `drive.file` and accept that only
    // OneCLI-created items are writable.
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/drive.readonly",
        name: "Read files and folders",
        description: "View and download all your Drive files and folders",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/drive",
        name: "Manage files and folders",
        description:
          "Create, edit, move, organize, and delete files and folders in your Drive",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.email",
        name: "Email address",
        description: "View your email address",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.profile",
        name: "Profile",
        description: "Name and profile picture",
        access: "read",
      },
    ],
    buildAuthUrl: buildGoogleAuthUrl,
    exchangeCode: exchangeGoogleCode,
  },
  available: true,
  configurable: {
    fields: googleConfigFields,
    envDefaults: googleEnvDefaults,
  },
};
