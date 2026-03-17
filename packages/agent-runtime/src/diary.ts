import type { InboundMessage } from "@codeclaw/types";
import { logger } from "./logger.js";

const DIARY_HOUR = parseInt(process.env.DIARY_HOUR ?? "4", 10);
const DIARY_TZ = process.env.DIARY_TIMEZONE ?? "Asia/Shanghai";

/** Get yesterday's date string (YYYY-MM-DD) in the configured timezone. */
function getYesterdayStr(): string {
  const yesterday = new Date(Date.now() - 86_400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: DIARY_TZ }).format(yesterday);
}

/** Build the /diary trigger message (handled as a runtime command). */
export function buildDiaryTrigger(): InboundMessage {
  return {
    id: `diary-trigger-${Date.now()}`,
    channel: "__system__",
    sender: { id: "system", name: "System", channel: "__system__" },
    conversation: { id: "diary", type: "dm" },
    content: { type: "text", text: "/diary" },
    timestamp: Date.now(),
    metadata: { command: "/diary", args: "", raw: "/diary" },
  };
}

/** Build the diary prompt message (injected as first message of the diary session). */
export function buildDiaryMessage(overrideDate?: string): InboundMessage {
  const date = overrideDate ?? getYesterdayStr();
  const prompt = `[System] Daily diary task.

Date to review: ${date}

## Task

Review all conversations and activities from ${date}, then:
1. Write a diary entry to ~/diary/${date}.md
2. Update user profiles in ~/diary/profiles.md

## Data Sources

- Telegram chat logs: ~/.claude/data/telegram/${date}/*.jsonl
  - One file per chat, JSONL format (one JSON object per line)
  - Fields: seq, ts, tgMsgId, sender {id, name}, type, text/caption
- Your previous diary entries in ~/diary/ (for continuity)

## Instructions

- Use Glob to find all JSONL files for ${date}
- Dispatch a subagent for each JSONL file to analyze in parallel
  - Each subagent reads the full JSONL, summarizes: key topics, mood/tone, notable events, user behavior
- Synthesize all subagent summaries into a cohesive diary entry from your perspective
- Read ~/diary/profiles.md if it exists — update existing user entries and append new ones
- Create ~/diary/ directory if needed

## Diary Style

Write naturally in first person. Include what happened, your reflections, anything noteworthy or interesting.
Not a transcript — your own thoughts and observations about the day.

## Profiles

Free-form markdown, organized by user. Include whatever helps you in future interactions:
personality traits, interests, communication style, relationship context, memorable moments.

If there are no JSONL files for ${date}, write a brief note that it was a quiet day.`;

  return {
    id: `diary-prompt-${Date.now()}`,
    channel: "__system__",
    sender: { id: "system", name: "System", channel: "__system__" },
    conversation: { id: "diary", type: "dm" },
    content: { type: "text", text: prompt },
    timestamp: Date.now(),
  };
}

/** Schedule a recurring daily timer. Returns cleanup function. */
export function scheduleDiaryTimer(onTrigger: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNext() {
    const now = new Date();
    const timeStr = new Intl.DateTimeFormat("en-GB", {
      timeZone: DIARY_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(now);
    const [h, m, s] = timeStr.split(":").map(Number);
    const currentSec = h * 3600 + m * 60 + s;
    const targetSec = DIARY_HOUR * 3600;
    let diffSec = targetSec - currentSec;
    if (diffSec <= 0) diffSec += 86400;

    const targetTime = new Date(now.getTime() + diffSec * 1000);
    logger.info({ nextDiary: targetTime.toISOString(), delayMs: diffSec * 1000, diaryHour: DIARY_HOUR, timezone: DIARY_TZ }, "Diary timer scheduled");

    timer = setTimeout(() => {
      logger.info("Diary timer fired");
      onTrigger();
      scheduleNext();
    }, diffSec * 1000);
  }

  scheduleNext();

  return () => { if (timer) clearTimeout(timer); };
}
