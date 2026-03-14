#!/usr/bin/env bash
set -euo pipefail

# CodeClaw Agent 部署脚本
# 用法: ./scripts/deploy.sh [--build] [--logs]

CONTAINER_NAME="codeclaw-agent-andy"
IMAGE="codeclaw/agent-runtime:dev"
VOLUME="codeclaw-andy-home"
ENV_FILE="$HOME/.claude/config/agent.env"
DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export DOCKER_HOST

# --- 参数解析 ---
BUILD=false
LOGS=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --logs)  LOGS=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

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

# --- 启动 ---
echo "==> Starting $CONTAINER_NAME..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e CLAUDE_MODEL=aws-claude-opus-4-6 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  -v "$VOLUME":/home/codeclaw \
  -p 7001:7001 \
  "$IMAGE"

# --- 验证 ---
sleep 2
STATUS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}')
PORTS=$(docker ps --filter "name=$CONTAINER_NAME" --format '{{.Ports}}')

if echo "$STATUS" | grep -q "Up"; then
  echo "==> OK: $CONTAINER_NAME is running"
  echo "    Status: $STATUS"
  echo "    Ports:  $PORTS"
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
