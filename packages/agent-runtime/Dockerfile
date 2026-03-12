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

# Create non-root user
RUN useradd -u 1000 -m -s /bin/bash codeclaw && \
    mkdir -p /home/codeclaw/.claude/skills /home/codeclaw/.claude/data /home/codeclaw/.claude/cache /home/codeclaw/.claude/memory /home/codeclaw/.claude/config && \
    chown -R codeclaw:codeclaw /home/codeclaw

# Home directory is mounted as a volume for persistence
VOLUME /home/codeclaw
WORKDIR /home/codeclaw

USER codeclaw

# Start agent runtime
CMD ["node", "/app/index.js"]
