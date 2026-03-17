---
name: telegram
description: "Telegram channel: send/receive messages, reactions, stickers, polls. Use when handling Telegram conversations or querying Telegram chat history."
---

# Telegram

Communicate with users via Telegram. Messages arrive with a `[telegram/<chatId>]` header.

## MCP Tools

Tools are provided by the `telegram` MCP server (prefix: `mcp__telegram__`).

### Messaging

- `send_message` — Send text reply. Set `channel: "telegram"`, `conversation: "<chatId>"`.
- `edit_message` — Edit a previously sent bot message by `messageId`.
- `delete_message` — Delete a message (own messages, or others if bot is admin).

### Reactions

- `react_message` — Add/remove emoji reaction on a message. Supports standard Unicode emoji.

### Stickers

- `get_sticker_set` — Browse a sticker set with visual thumbnails. Returns paginated results.
- `send_sticker` — Send a sticker by `fileId` (get from `get_sticker_set`).

### Polls

- `send_poll` — Create a poll with 2-10 options.

### Progress

- `show_progress` — Toggle a progress status message. Use for long-running tasks only (multi-step analysis, complex searches). When active, replaces the automatic typing indicator. Call with `active: false` in parallel with `send_message` when ready to reply.

### History

- `get_message` — Fetch messages from chat history. Three modes:
  - **Single**: `seq` or `platformMessageId` → one message with attachments
  - **Range**: `seq`/`platformMessageId` + `before`/`after` → anchor ± context (text only by default)
  - **Recent**: omit `seq`/`platformMessageId`, set `before` (default 20) → latest N messages

## Chat History

Messages are persisted in `~/.claude/data/telegram/` by date.

### Directory Layout

```
~/.claude/data/telegram/
├── 2026-03-13/
│   ├── -123456789.jsonl        # Chat log (one JSON per line)
│   └── -123456789/
│       └── files/              # Downloaded media
│           ├── 42_photo.jpg
│           └── 55_sticker.webp
```

### JSONL Record Fields

| Field | Description |
|-------|-------------|
| `seq` | Message sequence number (0-based, resets daily, contiguous) |
| `ts` | Timestamp in milliseconds |
| `tgMsgId` | Telegram message ID |
| `sender` | `{ id, name }` |
| `type` | `text` \| `image` \| `sticker` \| `file` \| `audio` \| `other` |

Type-specific fields: `text`, `caption`, `fileId`, `emoji`, `setName`, `filename`, `size`, `duration`.

### Querying History

Search by keyword:
```bash
grep "关键词" ~/.claude/data/telegram/2026-03-13/-123456789.jsonl
```

Recent messages:
```bash
tail -20 ~/.claude/data/telegram/2026-03-13/-123456789.jsonl
```

By tgMsgId:
```bash
grep '"tgMsgId":42' ~/.claude/data/telegram/2026-03-13/-123456789.jsonl
```

Or use `get_message` tool: `channel="telegram"`, `conversation="-123456789"`, `date="2026-03-13"`, `platformMessageId=42`.

## Message References

Incoming messages may contain a reply-to header:

```
reply-to:2026-03-13/-123456789/tgMsgId:38
```

Format: `<date>/<chatId>/tgMsgId:<id>`. To resolve, use `get_message` with the parsed fields, or grep the JSONL file directly.

## Group Chat Behavior

- You only receive messages that @mention you or reply to your messages.
- Other messages are stored in the JSONL log but not forwarded.
- Use `get_message` or grep the JSONL for prior context when needed.
- If a group message doesn't need a response, simply do nothing — no tool call required.
