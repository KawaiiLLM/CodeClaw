# Telegram Skill 安装

## 前置条件
- 一个 Telegram Bot Token（从 @BotFather 获取）

## 安装步骤

### 1. 创建配置文件

```bash
cat > ~/.claude/config/telegram.json << 'EOF'
{
  "bot_token": "YOUR_BOT_TOKEN_HERE",
  "allowed_users": []
}
EOF
```

将 `YOUR_BOT_TOKEN_HERE` 替换为真实 token。
`allowed_users` 留空表示允许所有人，填入 Telegram user ID 可限制访问。

### 2. 注册 Skill

```bash
mkdir -p ~/.claude/skills/telegram
cp /codeclaw/skills/telegram/manifest.json ~/.claude/skills/telegram/
```

### 3. 重启生效

Skill 在下次容器启动时自动加载。如需立即生效，重启容器。

## 卸载

```bash
rm -rf ~/.claude/skills/telegram
rm ~/.claude/config/telegram.json
```

重启后 Skill 不再加载。聊天记录保留在 `~/.claude/data/telegram/`。
