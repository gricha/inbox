// No DOM here: the shots and the tests read the same list the sidebar draws.
// Settings' parts, each a route (#/settings/<id>) and an item of the sidebar while you're in Settings: the app's own under
// "App", then the integrations under theirs: each plugin, holding its account, its settings and the automations it
// comes with. automations: false for a plugin that comes with none.
export const SETTINGS_PARTS: readonly { id: string; name: string; plugin?: true; automations?: false }[] = [
  { id: "queue", name: "Inbox and notifications" },
  { id: "automations", name: "Automations" }, // your automations, then the Inbox's urgency criteria
  { id: "agent", name: "Agent" },
  { id: "usage", name: "Usage" }, // what the desk's model calls would cost at API prices
  { id: "app", name: "This device" }, // its theme, then the desktop app's own
  { id: "network", name: "Network" }, // Tailscale, then Local network
  { id: "github", name: "GitHub", plugin: true },
  { id: "sessions", name: "Sessions", plugin: true, automations: false },
  { id: "mcp", name: "MCP servers", plugin: true, automations: false }, // your agent's own, which automations name
];
