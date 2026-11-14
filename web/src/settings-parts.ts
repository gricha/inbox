// No DOM here: the shots and the tests read the same list the sidebar draws.
// Settings' parts, each a route (#/settings/<id>) and an item of the sidebar while you're in Settings: the core's, then under
// a hairline one per plugin, holding its account, its settings and the automations it comes with.
// automations: false for a plugin that comes with none.
export const SETTINGS_PARTS: readonly { id: string; name: string; plugin?: true; automations?: false }[] = [
  { id: "queue", name: "Inbox and notifications" },
  { id: "agent", name: "Local Agent Integration" },
  { id: "automations", name: "Automation Rules" }, // your automations, then the Inbox's urgency criteria
  { id: "appearance", name: "Appearance" },
  { id: "app", name: "This device" },
  { id: "tailscale", name: "Tailscale" },
  { id: "github", name: "GitHub", plugin: true },
  { id: "sessions", name: "Sessions", plugin: true, automations: false },
  { id: "gmail", name: "Gmail", plugin: true, automations: false },
];
