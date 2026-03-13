# Telegram 通道 Skill

收发 Telegram 消息。支持文本、图片、文件。

## 数据
- 聊天记录: `~/.claude/data/telegram/{chatId}.jsonl`
- 文件附件: `~/.claude/data/telegram/{chatId}/files/`
- 配置: `~/.claude/config/telegram.json`

## JSONL 格式
每条消息一行 JSON:
{"id":"tg_-12345_100","ts":1710300000,"sender":{"id":"123","name":"Alice"},"type":"text","text":"...","replyTo":null}

引用关系通过 id 字段关联。

## 查阅聊天记录
- 搜索关键词: `grep "关键词" ~/.claude/data/telegram/-12345.jsonl`
- 最近消息: `tail -20 ~/.claude/data/telegram/-12345.jsonl`
- 按 ID 查找: `grep "tg_-12345_100" ~/.claude/data/telegram/-12345.jsonl`
