FROM node:22-slim

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install common tools
RUN apt-get update && apt-get install -y \
    git curl wget jq sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy agent-runtime
WORKDIR /app
COPY packages/agent-runtime/dist/ /app/
COPY packages/agent-runtime/package.json /app/
RUN npm install --omit=dev

# Workspace is mounted as a volume
VOLUME /workspace
WORKDIR /workspace

# Start agent runtime
CMD ["node", "/app/index.js"]
