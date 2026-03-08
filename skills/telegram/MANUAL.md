# Telegram 通道 Skill

## 功能
收发 Telegram 消息。安装后，你可以通过 Telegram Bot 与用户对话。

## 安装步骤
1. 确保 config/telegram.json 存在且包含 bot_token
2. 安装依赖: cd skills/telegram && npm install
3. 启动服务: 使用 start_skill_service 工具
   - skillId: "telegram"
   - command: "node"
   - args: ["skills/telegram/service.js"]

## 配置 (config/telegram.json)
```json
{
  "bot_token": "必填, 从 @BotFather 获取",
  "allowed_users": ["可选, Telegram user ID 白名单, 留空则允许所有人"]
}
```

## 验证安装
服务启动后，向你的 Telegram Bot 发一条消息。
如果队列中出现来自 telegram 通道的消息，说明安装成功。

## 已知限制
- 图片/文件消息暂不支持，仅文本
- 群组消息需要 @mention bot 才会触发
