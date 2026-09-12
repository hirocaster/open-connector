import type { ProviderDefinition } from "../../core/types.ts";

import { homeBoxActions } from "./actions.ts";

const service = "homebox";

/**
 * HomeBox provider backed by a user-configured HomeBox instance.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "HomeBox",
  description:
    "Home inventory and organization. Search, create, and update items, locations, labels, maintenance records, and attachments on a self-hosted HomeBox instance.",
  categories: ["Productivity", "Data"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "Login Password",
      placeholder: "HOMEBOX_PASSWORD",
      description:
        "The password of your HomeBox account. HomeBox has no API keys: the provider logs in with this password and the username below to obtain a bearer token, and re-authenticates automatically when the token expires.",
      extraFields: [
        {
          key: "username",
          label: "Username (Email)",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "admin@example.com",
          description: "The email address you log in to HomeBox with. Any non-superuser account of the group works.",
        },
        {
          key: "baseUrl",
          label: "Instance Base URL",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "http://homebox.local:7745",
          description:
            "The root URL for your HomeBox instance. The API is served below it at /api/v1, so http://homebox.local or http://homebox.local/api both work.",
        },
      ],
    },
  ],
  homepageUrl: "https://homebox.software",
  actions: homeBoxActions,
};
