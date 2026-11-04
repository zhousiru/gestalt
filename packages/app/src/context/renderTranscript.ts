import type { MessageReceivedEvent } from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import type { SessionEventRecord } from "../session/schemas";
import { formatZonedDateTime } from "./time";

export interface RenderChatLogInput {
  records: readonly SessionEventRecord[];
  /** Where reply targets are looked up; usually the whole conversation. */
  conversationRecords: readonly SessionEventRecord[];
  timezone: string;
}

/** A compact chat log: date boundaries, minute times, and raw CQ-bearing text. */
export function renderChatLog(input: RenderChatLogInput): string {
  const replyTargets = new Map<string, SessionEventRecord>();
  for (const record of input.conversationRecords) {
    if (record.event.type === "MessageReceived") {
      replyTargets.set(record.event.message.id, record);
    }
  }

  const body: string[] = [];
  let currentDate: string | undefined;
  for (const record of input.records) {
    if (record.event.type !== "MessageReceived") {
      continue;
    }
    const timestamp = formatChatTimestamp(
      record.event.occurredAt,
      input.timezone
    );
    if (timestamp.date !== currentDate) {
      if (body.length > 0) {
        body.push("");
      }
      body.push(timestamp.date);
      currentDate = timestamp.date;
    }
    body.push(
      "",
      renderMessage(record.event, timestamp.time, replyTargets, input.timezone)
    );
  }
  return body.join("\n");
}

export function renderConversationTitle(conversation: {
  kind: "group" | "private";
  id: string;
  name?: string | undefined;
}): string {
  if (conversation.kind === "group") {
    return conversation.name
      ? `the group chat "${conversation.name}" (group_id=${conversation.id})`
      : `a group chat (group_id=${conversation.id})`;
  }
  return conversation.name
    ? `a private chat with "${conversation.name}" (user_id=${conversation.id})`
    : `a private chat (user_id=${conversation.id})`;
}

function renderMessage(
  event: MessageReceivedEvent,
  time: string,
  replyTargets: ReadonlyMap<string, SessionEventRecord>,
  timezone: string
): string {
  const senderName = event.sender.displayName ?? event.sender.id;
  const identity = [
    isSelfMessageEvent(event) ? "you" : undefined,
    `user_id=${event.sender.id}`,
    `message_id=${event.message.id}`,
    event.message.mentionsBot ? "mentioned you" : undefined
  ].filter((item): item is string => Boolean(item));
  const lines = [`[${time}] ${senderName} (${identity.join(", ")})`];

  if (event.message.replyToMessageId) {
    lines.push(
      renderReply(
        event.message.replyToMessageId,
        replyTargets.get(event.message.replyToMessageId),
        timezone
      )
    );
  }

  lines.push(event.message.rawText ?? event.message.text);
  return lines.join("\n");
}

function renderReply(
  replyToMessageId: string,
  target: SessionEventRecord | undefined,
  timezone: string
): string {
  if (!target || target.event.type !== "MessageReceived") {
    return `In reply to message_id=${replyToMessageId} (the original message is not available here)`;
  }

  const event = target.event;
  const senderName = event.sender.displayName ?? event.sender.id;
  const timestamp = formatChatTimestamp(event.occurredAt, timezone);
  const selfLabel = isSelfMessageEvent(event) ? ", you" : "";
  const quote = (event.message.rawText ?? event.message.text)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    `In reply to [${timestamp.date} ${timestamp.time}] ${senderName} (user_id=${event.sender.id}${selfLabel}, message_id=${event.message.id}):`,
    quote
  ].join("\n");
}

function formatChatTimestamp(
  value: string,
  timezone: string
): { date: string; time: string } {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) {
    const zoned = formatZonedDateTime(parsed, timezone);
    return { date: zoned.date, time: zoned.time };
  }
  return { date: "Unknown date", time: "??:??" };
}
