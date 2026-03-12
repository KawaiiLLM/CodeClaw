# Telegram 通道 Skill

## 功能
收发 Telegram 消息。支持文本、图片、文件。

## 数据目录
- 聊天记录: `~/.claude/data/telegram/{chatId}.jsonl`
- 文件附件: `~/.claude/data/telegram/{chatId}/files/`
- 配置文件: `~/.claude/config/telegram.json`

## 安装步骤
1. 确保 `~/.claude/config/telegram.json` 存在且包含 bot_token
2. 安装依赖: `cd ~/.claude/skills/telegram && npm install`
3. 启动服务: 使用 start_skill_service 工具
   - skillId: "telegram"
   - command: "node"
   - args: ["~/.claude/skills/telegram/service.js"]

## 配置 (~/.claude/config/telegram.json)
{
  "bot_token": "必填, 从 @BotFather 获取",
  "allowed_users": ["可选, Telegram user ID 白名单, 留空则允许所有人"]
}

## JSONL 格式
每条消息一行 JSON:
{"id":"tg_-12345_100","ts":1710300000,"sender":{"id":"123","name":"Alice"},"type":"text","text":"...","replyTo":null}

引用关系通过 id 字段关联，不嵌入被引用的文本内容。

## 查阅聊天记录
- 搜索特定关键词: `grep "关键词" ~/.claude/data/telegram/-12345.jsonl`
- 查看最近消息: `tail -20 ~/.claude/data/telegram/-12345.jsonl`
- 按消息 ID 查找: `grep "tg_-12345_100" ~/.claude/data/telegram/-12345.jsonl`
