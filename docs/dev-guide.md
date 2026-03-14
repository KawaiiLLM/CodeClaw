# CodeClaw 本地开发启动指南

## 前置条件

- macOS, Colima (Docker runtime)
- Node.js 22+, pnpm
- HTTP 代理 `127.0.0.1:7890` (大陆网络)

## 环境变量

| 变量 | 值 | 说明 |
|------|----|------|
| `DOCKER_HOST` | `unix:///Users/zhaoqixuan/.colima/default/docker.sock` | Colima socket 路径 |
| `ANTHROPIC_API_KEY` | `sk-proxy-xxx` | API Key |
| `ANTHROPIC_BASE_URL` | `https://proxy.moedb.moe` | API 代理 (大陆用) |
| `CLAUDE_MODEL` | `aws-claude-opus-4-6` | 模型 ID |
| `HTTP_PROXY` / `HTTPS_PROXY` | `http://host.docker.internal:7890` | 容器内代理 (外网访问) |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | Bedrock 代理不支持实验性参数, 必须设置 |

> Host 侧代理地址是 `127.0.0.1:7890`, 容器内必须用 `host.docker.internal:7890`.

## 一键启动

```bash
# 0. 确保 Colima 运行
colima start

# 1. 安装依赖
pnpm install

# 2. 构建 Docker 镜像
DOCKER_HOST=unix://~/.colima/default/docker.sock \
  docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .

# 3. 启动 Kernel (host 进程, port 19000)
npx tsx packages/kernel/src/index.ts &

# 4. 启动 Agent 容器
DOCKER_HOST=unix://~/.colima/default/docker.sock \
  docker run -d --name codeclaw-agent-andy \
  -v $(pwd)/.agent-home:/home/codeclaw \
  -p 7001-7099:7001-7099 \
  -e KERNEL_URL=http://host.docker.internal:19000 \
  -e AGENT_ID=andy \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_BASE_URL="https://proxy.moedb.moe" \
  -e CLAUDE_MODEL="aws-claude-opus-4-6" \
  -e HTTP_PROXY="http://host.docker.internal:7890" \
  -e HTTPS_PROXY="http://host.docker.internal:7890" \
  -e https_proxy="http://host.docker.internal:7890" \
  -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
  codeclaw/agent-runtime:dev

# 5. 验证
curl -s http://localhost:19000/api/status | jq .
DOCKER_HOST=unix://~/.colima/default/docker.sock docker logs -f codeclaw-agent-andy
```

> Telegram Skill 由容器内 Agent 自动启动 (manifest-based), 无需手动启动. 端口 7001-7099 映射到 host 供 Kernel 回调.

## 验证清单

| 检查项 | 命令 | 预期 |
|--------|------|------|
| Kernel 运行 | `curl -s localhost:19000/api/status \| jq .uptime` | 数字 (ms) |
| Telegram Skill 注册 | `curl -s localhost:19000/api/status \| jq .services` | 有 `telegram` 条目 |
| Skill 端口可达 (host) | `curl -s -o /dev/null -w '%{http_code}' localhost:7001/x` | `404` |
| Agent SDK 模式 | 日志中 `Agent mode detected` | `mode: "sdk"` |
| CLAUDE.md 加载 | `docker exec codeclaw-agent-andy cat ~/CLAUDE.md \| head -1` | `# 你是 CodeClaw Agent` |

## 重新部署 (代码变更后)

```bash
# 改了 Agent/Skill 代码 → 重新构建镜像 + 重启容器
DOCKER_HOST=unix://~/.colima/default/docker.sock docker stop codeclaw-agent-andy
DOCKER_HOST=unix://~/.colima/default/docker.sock docker rm codeclaw-agent-andy
DOCKER_HOST=unix://~/.colima/default/docker.sock \
  docker build -t codeclaw/agent-runtime:dev -f packages/agent-runtime/Dockerfile.dev .
# 然后重复 step 4

# 改了 Kernel 代码 → 重启 Kernel 进程
kill $(lsof -ti :19000)
npx tsx packages/kernel/src/index.ts &
# Kernel 重启后容器也要重启 (Skill 需重新注册)
DOCKER_HOST=unix://~/.colima/default/docker.sock docker restart codeclaw-agent-andy

# 只改了 CLAUDE.md → 不用重建镜像
cp workspace-template/CLAUDE.md .agent-home/CLAUDE.md
DOCKER_HOST=unix://~/.colima/default/docker.sock docker restart codeclaw-agent-andy
```

## 调试

```bash
# Agent 日志
DOCKER_HOST=unix://~/.colima/default/docker.sock docker logs --tail 50 codeclaw-agent-andy

# SDK session 调用链 (最新 session)
DOCKER_HOST=unix://~/.colima/default/docker.sock docker exec codeclaw-agent-andy \
  ls -lt ~/.claude/projects/-home-codeclaw/*.jsonl | head -1
# 拿到文件名后:
DOCKER_HOST=unix://~/.colima/default/docker.sock docker exec codeclaw-agent-andy \
  cat ~/.claude/projects/-home-codeclaw/<session-id>.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    obj = json.loads(line.strip())
    t = obj.get('type','?')
    if t == 'assistant':
        for b in obj.get('message',{}).get('content',[]):
            if b.get('type') == 'tool_use':
                print(f'[tool] {b[\"name\"]}({json.dumps(b.get(\"input\",{}), ensure_ascii=False)[:120]})')
            elif b.get('type') == 'text' and b['text'].strip():
                print(f'[text] {b[\"text\"][:150]}')
    elif t == 'user':
        content = obj.get('message',{}).get('content','')
        if isinstance(content, str):
            print(f'[user] {content[:120]}')
        elif isinstance(content, list):
            for b in content:
                if b.get('type') == 'tool_result':
                    c = b.get('content','')
                    err = 'ERROR: ' if b.get('is_error') else ''
                    txt = c if isinstance(c,str) else str([i.get('text','')[:80] for i in c] if isinstance(c,list) else c)
                    print(f'  -> {err}{txt[:150]}')
"

# 容器内直接测试 Skill 端点
DOCKER_HOST=unix://~/.colima/default/docker.sock docker exec codeclaw-agent-andy \
  curl -s http://localhost:7001/get_message -X POST \
  -H 'Content-Type: application/json' \
  -d '{"conversation":"5767700706","date":"2026-03-13","seq":0}' | jq .
```

## 常见坑

### Kernel 502 "fetch failed"

**症状**: Agent 调 `send_message` / `react_message` 返回 502.

**原因**: Kernel (host) 无法访问容器内 Skill 的端口.

**修复**: docker run 时加 `-p 7001-7099:7001-7099`. Skill 注册的 `endpoint: http://localhost:7001` 从 host 视角必须可达.

### Kernel 代码过时

**症状**: 新功能 (如 `skillEndpoint` 路由) 不生效, 走到错误的 Skill 端点.

**修复**: `kill $(lsof -ti :19000)` 然后重启 Kernel. **Kernel 重启后必须重启 Agent 容器** (Skill 需重新注册).

### Agent 不遵守 CLAUDE.md 规则

**症状**: Agent 不回 emoji reaction, 不按行为准则办事.

**原因**: `workspace-template/CLAUDE.md` 没进容器. SDK 的 `settingSources: ["project"]` 在 `~/CLAUDE.md` 找不到文件.

**修复**: `cp workspace-template/CLAUDE.md .agent-home/CLAUDE.md` 然后重启容器. 新构建的镜像会在 CMD 中自动复制.

### Colima Docker socket 连不上

**症状**: `Cannot connect to the Docker daemon`.

**修复**: `colima stop && colima start`. 重启后原容器变为 Exited, 需要 `docker start codeclaw-agent-andy`.

### Agent 把 command 和 args 传错导致 spawn 崩溃

**症状**: 日志中出现 `ENOENT spawn "tsx /codeclaw/skills/telegram/service.ts"`.

**已修复**: `skill-service-manager.ts` 现在自动拆分含空格的 command, 并捕获 spawn error.

## 架构速查

```
Host                          Container (codeclaw-agent-andy)
-----------                   ----------------------------------
Kernel (:19000)  <---HTTP-->  Agent Runtime (SDK mode)
      |                            |
      |  routeOutbound()           |  MCP tools (kernelClient)
      |                            |
      +---HTTP(:7001)-------> Telegram Skill (:7001 inside)
                                   |
                              Grammy Bot --> Telegram API
```

- Kernel 是纯路由, 不解析消息语义
- Agent 所有出站操作都经过 Kernel (`kernelClient.sendOutbound`)
- Skill 端口必须映射到 host (`-p 7001-7099:7001-7099`), 否则 Kernel 无法回调
