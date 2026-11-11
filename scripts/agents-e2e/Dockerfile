# Codex and OpenCode beside Node, to drive the desk's agent paths against a real model. No key in any layer: it comes
# with --env-file at run time, and each agent's own config pointing it at OpenRouter is written by entry.sh then.
FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.154.0
ARG OPENCODE_VERSION=1.18.34

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force

# The node image's own unprivileged user, so neither agent runs as root.
USER node
WORKDIR /home/node
COPY --chown=node:node entry.sh /usr/local/bin/agents-e2e
ENTRYPOINT ["/usr/local/bin/agents-e2e"]
