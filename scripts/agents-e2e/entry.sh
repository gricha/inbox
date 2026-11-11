#!/bin/sh
# Points each agent at OpenRouter in its own config, inside the container only, then runs what was asked (the driver by
# default). The key stays in the environment: both configs name the variable, never its value.
set -eu
: "${OPENROUTER_API_KEY:?pass the key with --env-file}"
MODEL="${E2E_MODEL:-openai/gpt-5-mini}"

mkdir -p "$HOME/.codex" "$HOME/.config/opencode"
cat >"$HOME/.codex/config.toml" <<EOF
model = "$MODEL"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
EOF

cat >"$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "openrouter/$MODEL",
  "autoupdate": false,
  "share": "disabled"
}
EOF

if [ $# -eq 0 ]; then
  set -- node --disable-warning=ExperimentalWarning /src/scripts/agents-e2e/drive.ts
fi
exec "$@"
