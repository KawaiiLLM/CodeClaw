#!/usr/bin/env bash
set -euo pipefail

# CodeClaw Agent 部署脚本
# 用法:
#   ./scripts/deploy.sh [--build] [--logs] [AGENT_ID]
#   ./scripts/deploy.sh --build anon        # 构建并部署 anon
#   ./scripts/deploy.sh sakiko              # 部署 sakiko（不构建）
#
# 环境变量（可选）:
#   CLAUDE_MODEL          模型 ID（默认 aws-claude-opus-4-6）
#   SILENT_MODE=1         静默模式：只记录聊天，不调 LLM/不回复
#   DEPLOY_CPUS=1         CPU 核数上限（防失控）
#   DEPLOY_MEMORY=1g      内存上限（超限触发 cgroup OOM，保护宿主）
#   DEPLOY_PORT=7002      Skill 端口（默认 7001）
#   DEPLOY_EXTRA_VOLUME   额外只读挂载，如 codeclaw-sakiko-home:/home/codeclaw/sakiko:ro
#
# anon 静默模式部署示例:
#   SILENT_MODE=1 DEPLOY_CPUS=1 DEPLOY_MEMORY=1g \
#     DEPLOY_EXTRA_VOLUME=codeclaw-sakiko-home:/home/codeclaw/sakiko:ro \
#     ./scripts/deploy.sh anon

IMAGE="codeclaw/agent-runtime:dev"

# Auto-detect Docker: Colima (macOS) or native (Linux)
if [ -S "$HOME/.colima/default/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

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

AGENT_ID="${AGENT_ID:-anon}"
CONTAINER_NAME="codeclaw-agent-${AGENT_ID}"
VOLUME="${DEPLOY_VOLUME:-codeclaw-${AGENT_ID}-home}"
MODEL="${DEPLOY_MODEL:-aws-claude-opus-4-6}"
ENV_FILE="$HOME/.claude/config/agent-${AGENT_ID}.env"

# --- 前置检查 ---
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE"
  echo "Should contain ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker not available"
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

# --- 端口映射（anon=7001, 其他通过 DEPLOY_PORT 指定）---
PORT="${DEPLOY_PORT:-7001}"

# --- 环境变量 ---
# HTTP_PROXY: only set if running behind a firewall (e.g. China mainland)
EXTRA_ENV=()
if [ -n "${HTTP_PROXY:-}" ]; then
  EXTRA_ENV+=(-e "HTTP_PROXY=$HTTP_PROXY")
fi
# SILENT_MODE: passive logging only (no SDK, no LLM, no typing/replies)
if [ -n "${SILENT_MODE:-}" ]; then
  EXTRA_ENV+=(-e "SILENT_MODE=$SILENT_MODE")
fi

# --- 资源限制（可选，防止 agent 失控吃满宿主 CPU/内存）---
RESOURCE_ARGS=()
if [ -n "${DEPLOY_CPUS:-}" ]; then
  RESOURCE_ARGS+=(--cpus="$DEPLOY_CPUS")
fi
if [ -n "${DEPLOY_MEMORY:-}" ]; then
  RESOURCE_ARGS+=(--memory="$DEPLOY_MEMORY")
fi

# --- 额外只读 volume（如 anon 读 sakiko 工作空间）---
# 格式: "volume-name:/container/path:ro"
EXTRA_VOLUMES=()
if [ -n "${DEPLOY_EXTRA_VOLUME:-}" ]; then
  EXTRA_VOLUMES+=(-v "$DEPLOY_EXTRA_VOLUME")
fi

# --- 启动 ---
echo "==> Starting $CONTAINER_NAME (agent=$AGENT_ID, port=$PORT)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  "${RESOURCE_ARGS[@]+"${RESOURCE_ARGS[@]}"}" \
  --env-file "$ENV_FILE" \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID="$AGENT_ID" \
  -e CLAUDE_MODEL="$MODEL" \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  -e SKILL_HOST_PORT="$PORT" \
  "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}" \
  -v "$VOLUME":/home/codeclaw \
  "${EXTRA_VOLUMES[@]+"${EXTRA_VOLUMES[@]}"}" \
  -p "$PORT":7001 \
  --add-host=host.docker.internal:host-gateway \
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
