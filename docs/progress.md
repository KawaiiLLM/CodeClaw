# CodeClaw 实现进度记录

> 最后更新: 2026-03-14
> 最新提交: `5b0fe42` feat: runtime-level progress display replacing agent-driven update_progress

---

## 阶段总览

| Phase | 状态 | 说明 |
|-------|------|------|
| Phase 0: 项目脚手架 | 完成 | monorepo + 类型 + workspace 模板 |
| Phase 1: 最小内核 | 完成 | 全部子系统实现 + 两轮 code review |
| Phase 2: Agent 容器运行时 | 完成 | SDK/chat/stub 三层模式均已实现并验证 |
| Phase 3: Telegram Skill | 完成 | grammy + 代理 + 图片/贴纸 + 群聊@过滤 |
| Phase 4: 端到端联调 | 完成 | SDK 模式全链路已验证 (Telegram → Agent SDK → Claude → Telegram) |
| Phase 5a: Home 目录迁移 | 完成 | /workspace → /home/codeclaw, JSONL 聊天持久化 |
| Phase 5: 活跃状态 + 进度消息 | 完成 | 两层信号架构: Chat Action (typing) + Runtime ProgressTracker |
| Phase 5b: Telegram 增强 | 完成 | JSONL 重构, 401 熔断器, 10 个 MCP 工具, 出站语义分流 |
| Phase 5c: 斜杠命令系统 | 完成 | 三层斜杠命令, 贴纸缓存, doExport 401 抑制 |
| Phase 6: 安全约束与审批 | 待实现 | 白名单 + Emoji 审批 |

---

## 提交历史

```
5b0fe42 feat: runtime-level progress display replacing agent-driven update_progress
76109dd fix: code review — 修复过时文档引用 + 删除未使用的 mcp-server
2338ed4 fix: @mention 时立即开启群消息监听窗口
a45222e feat: group chat listen window — send_message 自动开启群消息监听
b868c65 refactor: Agent CLAUDE.md 转向行为哲学 + 同步清理已删工具引用
4aa612d refactor: 精简设计哲学 + MCP 工具瘦身 (14→10)
0c2d8a5 feat: three-layer slash command system + sticker cache + doExport suppression
a3e3b04 fix: remove leaked API key from docs, suppress SDK doExport 401
4da9d12 fix: expose tgMsgId in notification header, clarify tool messageId
e500ff6 docs: add local development startup guide
ec38d1d fix: copy CLAUDE.md into agent home on container start
b6785b3 fix: stop typing on send_message + safeSlice for surrogate safety
514bdb3 feat: Phase 5 — typing indicators + progress messages (two-layer signals)
d0b20fe docs: address Phase 5 plan review — 3 fixes
3877daf docs: rewrite Phase 5 plan — two-layer signal architecture
6575886 docs: distill core philosophy — Agent OS, not Chatbot Framework
ea7c52b fix: address code review Critical and Important issues
ea1c0d8 feat: manifest-based skill lifecycle with dynamic port allocation
031db3c feat: run Telegram Skill inside container as child process
6d26bf7 fix: address code review Critical and Important issues
227c239 refactor: migrate from /workspace to /home/codeclaw + JSONL chat persistence
868058f feat: implement CodeClaw MVP (Phase 0-3)
```

---

## 已验证里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| M1: 内核 HTTP API | 完成 | curl 收发消息, 队列入队/出队 |
| M2: Agent 容器通信 | 完成 | 容器启动, 轮询内核, 收发消息 |
| M3: Agent 回复消息 | 完成 | 收到消息 → 调 Claude API → 回复 |
| M4: Telegram 端到端 | 完成 | TG 消息 → Bot → 内核 → Agent → Claude → 内核 → Bot → TG |
| M5: SDK Agent 模式 | 完成 | Agent SDK query() + MCP tools + session resume 全链路 |
| M6: Telegram 多媒体 | 完成 | 图片 / 贴纸 / 回复引用 → base64 multimodal → Claude Vision |
| M7: 群聊 @提及过滤 | 完成 | 群聊仅在 @bot 或回复 bot 时响应 |
| M8: Home 目录迁移 | 完成 | /workspace → /home/codeclaw, JSONL 聊天持久化 |
| M9: Typing 指示器 | 完成 | 处理消息时 Telegram 显示"正在输入...", 回复后立即停止 |
| M10: 进度消息 | 完成 | Runtime ProgressTracker 自动展示工具调用链, 零 token 成本 |
| M11: JSONL 重构 | 完成 | date 目录 + seq ID, Skill-side 通知格式化, 引用消息持久化 |
| M12: 401 熔断器 | 完成 | sendChatAction 指数退避 + 永久挂起, Grammy error_code 检测 |
| M13: Rich Agent 工具 | 完成 | 9 个 MCP 工具: react/edit/delete/sticker/poll/get_message + 出站语义分流 |
| M14: 架构边界清理 | 完成 | Agent Runtime 纯透传, Telegram 细节移至 SKILL.md |
| M15: 斜杠命令系统 | 完成 | 三层斜杠命令 (Skill/Kernel/Agent), 自定义命令注册 |
| M16: 贴纸缓存 | 完成 | 贴纸包本地缓存, 减少重复 API 调用 |
| M17: doExport 401 抑制 | 完成 | SDK doExport 请求 401 错误静默处理, 不中断 Agent loop |
| M18: 工具瘦身 | 完成 | 14→9 MCP 工具, 移除 Skill 管理工具 + update_progress |
| M19: 群消息监听窗口 | 完成 | send_message 自动开启群消息监听 (默认 3 分钟) |
| M20: Runtime 进度显示 | 完成 | ProgressTracker 拦截 SDK 事件流, CC 风格工具调用链, 零 token |

---

## 技术债

1. **内核 ContainerManager Colima socket**: `findDockerSocket()` 在 ESM 环境下可能有问题, 需设 `DOCKER_HOST` 环境变量
2. **Telegram Skill 代理限制**: Grammy transformer + undici ProxyAgent 硬编码 `Content-Type: application/json`, 不支持 multipart/form-data
3. **Chat 模式无工具**: chat 模式仍为纯文字对话, mcp-server.ts 未在 chat 模式中使用
4. **Skill 安装体验**: 当前手动配置, 未实现通过自然语言安装
5. **JSONL 同步写入**: `appendFileSync` 在高消息量下可能阻塞 event loop
6. **容器镜像设计**: 基础镜像内容、Skill 依赖动态安装机制待规范
7. **升级策略**: 内核升级时 home 目录兼容性、Skill 版本管理
8. **Emoji 审批协议**: 审批消息格式、reaction 监听、超时策略 (Phase 6 前置设计)
