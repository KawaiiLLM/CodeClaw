#!/usr/bin/env bash
set -euo pipefail

# CodeClaw Agent 部署脚本
# 用法:
#   ./scripts/deploy.sh [--build] [--logs] [AGENT_ID]
#   ./scripts/deploy.sh --build andy        # 构建并部署 andy
#   ./scripts/deploy.sh bob                 # 部署 bob（不构建）

IMAGE="codeclaw/agent-runtime:dev"
DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export DOCKER_HOST

# --- 参数解析 ---
BUILD=false
LOGS=false
AGENT_ID=""
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --logs)  LOGS=true ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *) AGENT_ID="$arg" ;;
  esac
done

AGENT_ID="${AGENT_ID:-andy}"
CONTAINER_NAME="codeclaw-agent-${AGENT_ID}"
VOLUME="codeclaw-${AGENT_ID}-home"
ENV_FILE="$HOME/.claude/config/agent-${AGENT_ID}.env"

# Fallback to legacy env file for 'andy'
if [ ! -f "$ENV_FILE" ] && [ "$AGENT_ID" = "andy" ]; then
  ENV_FILE="$HOME/.claude/config/agent.env"
fi

# --- 前置检查 ---
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE"
  echo "Should contain ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker not available. Is Colima running?"
  echo "  colima start"
  exit 1
fi

# --- 构建镜像 ---
if [ "$BUILD" = true ]; then
  echo "==> Building image..."
  docker build -t "$IMAGE" -f packages/agent-runtime/Dockerfile.dev .
fi

# --- 确认 volume 存在 ---
if ! docker volume ls -q | grep -q "^${VOLUME}$"; then
  echo "WARNING: Volume $VOLUME does not exist, will be created fresh"
fi

# --- 停止旧容器 ---
if docker ps -q --filter "name=$CONTAINER_NAME" | grep -q .; then
  echo "==> Stopping $CONTAINER_NAME..."
  docker stop "$CONTAINER_NAME"
fi
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# --- 端口映射（andy=7001, 其他通过 DEPLOY_PORT 指定）---
PORT="${DEPLOY_PORT:-7001}"

# --- 启动 ---
echo "==> Starting $CONTAINER_NAME (agent=$AGENT_ID, port=$PORT)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID="$AGENT_ID" \
  -e CLAUDE_MODEL=aws-claude-opus-4-6 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  -v "$VOLUME":/home/codeclaw \
  -p "$PORT":7001 \
  "$IMAGE"

# --- 验证 ---
sleep 2
STATUS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}')
PORTS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Ports}}')

if echo "$STATUS" | grep -q "Up"; then
  echo "==> OK: $CONTAINER_NAME is running"
  echo "    Agent:  $AGENT_ID"
  echo "    Status: $STATUS"
  echo "    Ports:  $PORTS"
  echo "    Volume: $VOLUME"
else
  echo "ERROR: Container failed to start"
  docker logs --tail 30 "$CONTAINER_NAME"
  exit 1
fi

# --- 可选: 跟踪日志 ---
if [ "$LOGS" = true ]; then
  echo "==> Following logs (Ctrl+C to stop)..."
  docker logs -f "$CONTAINER_NAME"
fi
