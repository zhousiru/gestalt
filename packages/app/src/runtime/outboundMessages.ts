import type { CanonicalEvent, Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { AppendEventOptions } from "../session/store";
import type { SessionEventRecord } from "../session/schemas";
import type { ToolExecutionResult } from "../tools/results";
import type { ActionProposal } from "../tools/schemas";

export interface CommitOutboundMessageInput {
  config: GestaltConfig;
  sourceEvent: CanonicalEvent;
  proposal: ActionProposal;
  result: ToolExecutionResult;
  appendEvent(
    event: CanonicalEvent,
    options?: AppendEventOptions
  ): Promise<SessionEventRecord>;
  flushDurable(): Promise<void>;
}

/**
 * Commits a known-success outbound message to its target conversation before
 * model execution may continue. The message contains no connector locator or
 * binary payload; stickers use a transcript-safe description.
 */
export async function commitOutboundMessage(
  input: CommitOutboundMessageInput
): Promise<SessionEventRecord | undefined> {
  if (input.result.status !== "executed") {
    return undefined;
  }
  const target = outboundMessageTarget(input.proposal, input.result);
  if (!target) {
    return undefined;
  }

  const selfId =
    readOptionalString(input.config.flatValues, "bot_user_id") ??
    input.sourceEvent.source.accountId ??
    "gestalt-bot";
  const selfName =
    readOptionalString(input.config.flatValues, "bot_display_name") ??
    "Gestalt";
  const occurredAt = input.result.executedAt;
  const externalId = input.result.result?.externalId;
  const record = await input.appendEvent(
    {
      id: `self-event-${input.proposal.id}`,
      type: "MessageReceived",
      occurredAt,
      source: {
        platform: input.sourceEvent.source.platform,
        connector: "runtime-self",
        accountId: selfId,
        rawEventId: externalId ?? input.proposal.id
      },
      conversation: target.conversation,
      sender: {
        id: selfId,
        displayName: selfName,
        isSelf: true
      },
      message: {
        id: externalId ?? `self-message-${input.proposal.id}`,
        text: target.text,
        rawText: target.text,
        mentionsBot: false,
        ...(target.replyToMessageId
          ? { replyToMessageId: target.replyToMessageId }
          : {})
      },
      ...(target.raw ? { raw: target.raw } : {})
    },
    { receivedAt: occurredAt }
  );
  await input.flushDurable();
  return record;
}

function outboundMessageTarget(
  proposal: ActionProposal,
  result: ToolExecutionResult
):
  | {
      conversation: Conversation;
      text: string;
      replyToMessageId?: string;
      raw?: Record<string, unknown>;
    }
  | undefined {
  if (proposal.toolName !== "say") {
    return undefined;
  }
  const { conversation, replyTo, stickerId, text } = proposal.params;
  if (stickerId) {
    return {
      conversation,
      text: stickerTranscriptText(stickerId, result),
      raw: { generatedBy: "say", stickerId },
      ...(replyTo ? { replyToMessageId: replyTo } : {})
    };
  }
  return {
    conversation,
    text: text ?? "",
    ...(replyTo ? { replyToMessageId: replyTo } : {})
  };
}

function stickerTranscriptText(
  stickerId: string,
  result: ToolExecutionResult
): string {
  const data =
    result.result?.data &&
    typeof result.result.data === "object" &&
    !Array.isArray(result.result.data)
      ? (result.result.data as Record<string, unknown>)
      : undefined;
  const description = typeof data?.visual === "string" ? data.visual : undefined;
  return description
    ? `[表情包 ${stickerId}：${description}]`
    : `[表情包 ${stickerId}]`;
}

function readOptionalString(
  flat: GestaltConfig["flatValues"],
  key: string
): string | undefined {
  const value = flat[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config value ${key} must be a string.`);
  }
  return value;
}
