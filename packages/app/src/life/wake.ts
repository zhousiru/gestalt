import { randomUUID } from "node:crypto";
import type { Connector, ConnectorCallResult } from "../connectors/types";
import { isConnectorOutcomeUnknownError } from "../connectors/types";
import { renderChatLog, renderConversationTitle } from "../context/renderTranscript";
import { formatZonedDateTime } from "../context/time";
import { isSelfMessageEvent } from "../events/helpers";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { LiveEventSink } from "../live/viewTypes";
import { readImageContentForModel } from "../model/readImageContent";
import type {
  ImageAttachment,
  ModelClient,
  ModelExchangePurpose,
  ModelUsageTotals,
  ToolOutcome
} from "../model/session";
import { readModelStepsFromError } from "../model/session";
import {
  renderDreamPrompt,
  renderLifeSystemPrompt,
  renderPlaceView,
  renderUnfinishedPrompt,
  renderWakePrompt
} from "../prompts/life";
import { createRenderedPrompt } from "../prompts/hash";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import { createActiveRollout, type ActiveRollout } from "../runtime/activeRollout";
import type { SessionHistoryReader } from "../session/history";
import type { SessionEventRecord, WakeRecord } from "../session/schemas";
import { getConversationKey, type SessionStore } from "../session/store";
import type { StickerService } from "../stickers/service";
import type { NativeCommandTarget } from "../tools/agentBrowser";
import { REACTION_EMOJIS, REACTION_EMOJI_NAMES } from "../tools/emojis";
import type { ToolExecutionResult } from "../tools/results";
import {
  ActionProposalSchema,
  isVisibleSideEffect,
  type ActionProposal,
  type ToolDefinition,
  type ToolName
} from "../tools/schemas";
import { createWakeBash, type WakeBash, type WakeMounts } from "./bash";
import type { LifeClock } from "./clock";
import type { LifeConfig } from "./config";
import { dateInDay, formatDuration } from "./time";
import { isMessageRecord, readPhone, selectUnreadRecords } from "./phone";
import {
  DREAM_PLACE,
  WEB_PLACE,
  conversationIdFromPlace,
  placeIdForConversation
} from "./places";
import type { LifeState } from "./state";
import type { LifeStore } from "./store";

const MAX_HOLDS_PER_WAKE = 2;
const MAX_INLINE_DIARY_CHARS = 16_000;
const SEARCH_LOOKBACK_DAYS = 180;
const SEARCH_RESULT_LIMIT = 20;
const DIARY_DAYS = 3;

export type WakeReason = WakeRecord["reason"];

export interface WakeDependencies {
  home: GestaltHome;
  gestaltConfig: GestaltConfig;
  config: LifeConfig;
  life: LifeStore;
  clock: LifeClock;
  timezone: string;
  tools: readonly ToolDefinition[];
  sessionStore: SessionStore;
  sessionHistory: SessionHistoryReader;
  connector: Connector;
  model: ModelClient;
  allowedGroupIds?: ReadonlySet<string> | undefined;
  stickers?: StickerService | undefined;
  agentBrowserTarget?: NativeCommandTarget;
  liveEvents?: LiveEventSink | undefined;
  commitOutbound(input: {
    proposal: ActionProposal;
    result: ToolExecutionResult;
    sourceEvent: CanonicalEvent;
  }): Promise<void>;
  onPhase(phase: "working" | "typing"): void;
}

export interface WakeInput {
  reason: WakeReason;
  state: LifeState;
  dream: boolean;
  dreamReason?: string;
}

export interface WakeResult {
  id: string;
  rolloutId: string;
  reason: WakeReason;
  kind: "day" | "dream";
  place?: string;
  status: "completed" | "failed";
  startedAt: string;
  endedAt: string;
  requestedSleepSeconds?: number;
  doNotDisturb: boolean;
  note?: string;
  said: number;
  held: number;
  usage: ModelUsageTotals;
  proposals: ActionProposal[];
  toolResults: ToolExecutionResult[];
  commit?: string;
  reverted: boolean;
  error?: string;
}

/**
 * One wake: everything the bot does between opening its eyes and going back to
 * sleep. The session starts empty, and only the home and the journal carry over.
 */
export async function runWake(
  dependencies: WakeDependencies,
  input: WakeInput
): Promise<WakeResult> {
  const { clock, config, life, sessionStore, connector, timezone } = dependencies;
  const { state } = input;
  const id = randomUUID();
  const startedAt = clock.now().toISOString();
  const lastDreamAtStart = state.lastDreamAt;
  const lastReadAtStart = { ...state.lastRead };
  const proposals: ActionProposal[] = [];
  const toolResults: ToolExecutionResult[] = [];
  const windowIds: string[] = [];
  const windowEventIds: string[] = [];
  const rollout = createActiveRollout({
    home: dependencies.home,
    config: dependencies.gestaltConfig,
    rolloutId: id,
    activeLoopId: id,
    conversationKey: "life:wake",
    tools: dependencies.tools,
    startedAt,
    now: clock.now
  });

  let place: string | undefined = input.dream ? DREAM_PLACE : undefined;
  let conversation: Conversation | undefined;
  let bash: WakeBash | undefined;
  let bashMounts: WakeMounts = input.dream ? { kind: "dream" } : { kind: "phone" };
  let sleepRequest:
    | { seconds: number; note?: string; doNotDisturb: boolean }
    | undefined;
  let held = 0;
  let said = 0;
  const saidTexts: string[] = [];

  const sourceEvent = (): CanonicalEvent => {
    const records = conversation ? sessionStore.getEvents(conversation) : [];
    const record = records.filter(isMessageRecord).at(-1);
    if (!record) {
      throw new Error("Saying something requires a conversation with messages.");
    }
    return record.event;
  };

  const shell = (): WakeBash => {
    bash ??= createWakeBash({
      wakeId: id,
      life,
      mounts: bashMounts,
      stickers: dependencies.stickers,
      ...(dependencies.agentBrowserTarget
        ? { agentBrowserTarget: dependencies.agentBrowserTarget }
        : {})
    });
    return bash;
  };

  // The mounts are the rule, so going somewhere means a different shell. One
  // opened on the phone must not follow it in.
  const remount = async (mounts: WakeMounts): Promise<void> => {
    await bash?.dispose();
    bash = undefined;
    bashMounts = mounts;
  };

  const recordsOf = (target: Conversation): SessionEventRecord[] =>
    sessionStore.getEvents(target);

  const markRead = (target: Conversation): void => {
    const last = recordsOf(target).filter(isMessageRecord).at(-1);
    if (last) {
      state.lastRead[placeIdForConversation(target)] = {
        eventId: last.event.id,
        at: last.receivedAt
      };
    }
  };

  const enterChat = async (target: Conversation): Promise<string> => {
    const placeId = placeIdForConversation(target);
    await life.ensurePlace(placeId);
    place = placeId;
    conversation = target;
    await remount({ kind: "place", place: placeId, chat: true });
    rollout.setConversationKey(getConversationKey(target));
    sessionStore.pinConversation(target);
    dependencies.liveEvents?.publish("agent.run.started", {
      traceId: id,
      conversationKey: getConversationKey(target),
      startedAt,
      messageCount: selectUnreadRecords(
        recordsOf(target),
        state.lastRead[placeId]
      ).length
    });

    const records = recordsOf(target);
    const unread = selectUnreadRecords(records, state.lastRead[placeId]);
    const shownUnread = unread.slice(-config.unreadLimit);
    const firstShown = shownUnread[0];
    const messages = records.filter(isMessageRecord);
    const boundary = firstShown
      ? messages.findIndex((record) => record.id === firstShown.id)
      : messages.length;
    const earlier = messages.slice(
      Math.max(0, boundary - config.contextMessageCount),
      boundary
    );
    const rest = firstShown ? messages.slice(boundary) : [];
    const windowRecords = unread.length > 0 ? shownUnread : messages.slice(-1);
    if (windowRecords.length > 0) {
      const part = await sessionStore.createMessageWindow({
        conversation: target,
        eventIds: windowRecords.map((record) => record.event.id),
        reason: "wake",
        closedAt: clock.now().toISOString()
      });
      windowIds.push(part.window.id);
      windowEventIds.push(...part.window.eventIds);
    }
    markRead(target);

    const chat = [
      earlier.length > 0
        ? renderChatLog({
            records: earlier,
            conversationRecords: records,
            timezone
          })
        : "",
      rest.length > 0
        ? `--- ${unread.length} unread${
            unread.length > shownUnread.length
              ? `, only the newest ${shownUnread.length} shown; use look with before to read more`
              : ""
          } ---\n\n${renderChatLog({
            records: rest,
            conversationRecords: records,
            timezone
          })}`
        : "--- nothing new ---"
    ]
      .filter(Boolean)
      .join("\n\n");

    return renderPlaceView({
      place: placeId,
      title: renderConversationTitle(target),
      memory: await life.readPlaceMemory(placeId),
      diary: await life.readRecentDiary(
        placeId,
        recentDates(clock.now(), config, timezone)
      ),
      chat
    });
  };

  const enterWeb = async (): Promise<string> => {
    place = WEB_PLACE;
    await remount({ kind: "place", place: WEB_PLACE, chat: false });
    rollout.setConversationKey("life:web");
    return renderPlaceView({
      place: WEB_PLACE,
      title: "your corner of the web. Use agent-browser in bash, and leave what you found as the note when you sleep",
      memory: await life.readPlaceMemory(WEB_PLACE),
      diary: await life.readRecentDiary(
        WEB_PLACE,
        recentDates(clock.now(), config, timezone)
      ),
      chat: ""
    });
  };

  const enterDream = async (): Promise<string> => {
    place = DREAM_PLACE;
    await remount({ kind: "dream" });
    rollout.setConversationKey("life:dream");
    return renderDreamOpening(
      life,
      lastDreamAtStart,
      clock.now(),
      timezone,
      input.dreamReason
    );
  };

  const look = async (
    params: Extract<ActionProposal, { toolName: "look" }>["params"]
  ): Promise<ToolOutcome> => {
    // Naming the place it is already in is not a second place. The rest of the
    // call still means what it says.
    if (params.place && params.place !== place) {
      if (place) {
        return {
          output: {
            status: "refused",
            reason: `You are in ${place}. A wake reaches one place. Sleep first, even briefly.`
          }
        };
      }
      if (params.place === WEB_PLACE) {
        return { output: { status: "ok", view: await enterWeb() } };
      }
      if (params.place === DREAM_PLACE) {
        return { output: { status: "ok", view: await enterDream() } };
      }
      const target = findConversation(params.place);
      if (!target) {
        return {
          output: {
            status: "refused",
            reason: `There is no place called ${params.place} on your phone.`
          }
        };
      }
      return { output: { status: "ok", view: await enterChat(target) } };
    }

    if (!conversation) {
      return {
        output: {
          status: "refused",
          reason: place
            ? "There is no chat to look at here."
            : "Pick a place from your phone first."
        }
      };
    }
    if (params.image) {
      return lookAtImage(params.image);
    }
    if (params.search) {
      return searchHistory(conversation, params.search);
    }
    if (params.before) {
      return lookBefore(conversation, params.before);
    }
    if (params.messageId) {
      return lookAtMessage(conversation, params.messageId);
    }
    return lookForNew();
  };

  const lookForNew = (): ToolOutcome => {
    if (!conversation) {
      return { output: { status: "ok", view: "Nothing new here." } };
    }
    const records = recordsOf(conversation);
    const unread = selectUnreadRecords(
      records,
      state.lastRead[placeIdForConversation(conversation)]
    );
    markRead(conversation);
    return {
      output: {
        status: "ok",
        view:
          unread.length > 0
            ? renderChatLog({
                records: unread,
                conversationRecords: records,
                timezone
              })
            : "Nothing new."
      }
    };
  };

  const lookBefore = (target: Conversation, before: string): ToolOutcome => {
    const records = recordsOf(target);
    const messages = records.filter(isMessageRecord);
    const index = messages.findIndex(
      (record) => record.event.message.id === before
    );
    if (index < 0) {
      return {
        output: { status: "failed", reason: `No message ${before} here.` }
      };
    }
    const page = messages.slice(
      Math.max(0, index - config.unreadLimit),
      index
    );
    return {
      output: {
        status: "ok",
        view: page.length
          ? renderChatLog({
              records: page,
              conversationRecords: records,
              timezone
            })
          : "That is as far back as you can scroll."
      }
    };
  };

  const lookAtMessage = async (
    target: Conversation,
    messageId: string
  ): Promise<ToolOutcome> => {
    const records = recordsOf(target);
    const found = records
      .filter(isMessageRecord)
      .find((record) => record.event.message.id === messageId);
    if (found) {
      return {
        output: {
          status: "ok",
          view: renderChatLog({
            records: [found],
            conversationRecords: records,
            timezone
          })
        }
      };
    }
    const history = await dependencies.sessionHistory.findRecentMessage(
      target,
      messageId,
      new Date(clock.now().valueOf() - SEARCH_LOOKBACK_DAYS * 86_400_000)
    );
    if (history) {
      return {
        output: {
          status: "ok",
          view: renderChatLog({
            records: [history],
            conversationRecords: [history],
            timezone
          })
        }
      };
    }
    const fetched = await connector.fetchMessage({ messageId });
    return {
      output: fetched.ok
        ? {
            status: "ok",
            message: truncateData(sanitizeUntrustedValue(fetched.data))
          }
        : { status: "failed", reason: fetched.error ?? "Message not found." }
    };
  };

  const searchHistory = async (
    target: Conversation,
    query: string
  ): Promise<ToolOutcome> => {
    const page = await dependencies.sessionHistory.searchMessages(
      query,
      { conversation: target },
      {
        since: new Date(
          clock.now().valueOf() - SEARCH_LOOKBACK_DAYS * 86_400_000
        )
      },
      undefined,
      SEARCH_RESULT_LIMIT
    );
    const live = recordsOf(target)
      .filter(isMessageRecord)
      .filter((record) =>
        (record.event.message.rawText ?? record.event.message.text).includes(
          query
        )
      );
    const merged = new Map<string, SessionEventRecord>();
    for (const record of [...page.items, ...live]) {
      merged.set(record.event.id, record);
    }
    const items = Array.from(merged.values())
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      .slice(-SEARCH_RESULT_LIMIT);
    return {
      output: {
        status: "ok",
        view: items.length
          ? renderChatLog({
              records: items,
              conversationRecords: recordsOf(target),
              timezone
            })
          : `Nothing here mentions ${query}.`
      }
    };
  };

  const lookAtImage = async (file: string): Promise<ToolOutcome> => {
    const result = await connector.readImage({ file });
    if (!result.ok || !result.media) {
      return {
        output: {
          status: "failed",
          reason: result.error ?? "The image could not be read."
        }
      };
    }
    try {
      const content = await readImageContentForModel(result.media);
      const image: ImageAttachment = {
        label: `The image ${JSON.stringify(file)}.`,
        data: content.data,
        mediaType: content.mediaType
      };
      return { output: { status: "ok" }, images: [image] };
    } catch (error) {
      return { output: { status: "failed", reason: errorMessage(error) } };
    }
  };

  const findConversation = (placeId: string): Conversation | undefined => {
    const identity = conversationIdFromPlace(placeId);
    if (!identity) {
      return undefined;
    }
    if (
      identity.kind === "group" &&
      dependencies.allowedGroupIds &&
      !dependencies.allowedGroupIds.has(identity.id)
    ) {
      return undefined;
    }
    return sessionStore
      .listConversations()
      .find(
        (candidate) =>
          candidate.kind === identity.kind && candidate.id === identity.id
      );
  };

  /** Runs a visible effect across the durable outbound boundary. */
  const runOutbound = async (
    proposal: ActionProposal,
    send: () => Promise<ConnectorCallResult>
  ): Promise<ToolExecutionResult> => {
    await rollout.recordToolStarted(proposal, true);
    let result: ToolExecutionResult;
    try {
      const connectorResult = await send();
      result = {
        proposal,
        status: connectorResult.ok ? "executed" : "failed",
        result: connectorResult,
        executedAt: clock.now().toISOString()
      };
    } catch (error) {
      result = {
        proposal,
        status: isConnectorOutcomeUnknownError(error)
          ? "result_unknown"
          : "failed",
        reason: isConnectorOutcomeUnknownError(error)
          ? "The action was dispatched, but its result is unknown. It must not be retried."
          : errorMessage(error),
        executedAt: clock.now().toISOString()
      };
    }
    if (result.status === "executed" && proposal.toolName === "say") {
      await dependencies.commitOutbound({
        proposal,
        result,
        sourceEvent: sourceEvent()
      });
      if (conversation) {
        markRead(conversation);
      }
      said += 1;
      const text = readString(proposal.params.text);
      if (text) {
        saidTexts.push(text);
      }
    }
    await rollout.recordToolFinished(proposal, result, true);
    return result;
  };

  const say = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    if (!conversation) {
      return {
        output: {
          status: "refused",
          reason: place
            ? "Nobody can hear you here."
            : "You are not in any chat. Go somewhere with look first."
        }
      };
    }
    const target = conversation;
    const text = readString(args.text);
    const stickerId = readString(args.sticker_id);
    const replyTo = readString(args.reply_to);
    if (!text && !stickerId) {
      return {
        output: { status: "failed", reason: "say needs text or sticker_id." }
      };
    }

    if (text) {
      const chars = Array.from(text).length;
      dependencies.onPhase("typing");
      await clock.sleep(
        clamp(
          chars * config.typingMsPerChar,
          config.typingMinMs,
          config.typingMaxMs
        )
      );
      dependencies.onPhase("working");
    }

    const records = recordsOf(target);
    const fresh = selectUnreadRecords(
      records,
      state.lastRead[placeIdForConversation(target)]
    );
    if (fresh.length > 0 && held < MAX_HOLDS_PER_WAKE) {
      held += 1;
      markRead(target);
      return {
        output: {
          status: "held",
          reason: "New messages came in while you were typing, so nothing was sent. Read them and decide again. Call say again to send, or don't.",
          new_messages: renderChatLog({
            records: fresh,
            conversationRecords: records,
            timezone
          })
        }
      };
    }

    const results: ToolExecutionResult[] = [];
    if (text) {
      const proposal = ActionProposalSchema.parse({
        id: randomUUID(),
        proposedAt: clock.now().toISOString(),
        toolName: "say",
        params: {
          conversation: target,
          text,
          ...(replyTo ? { replyTo } : {})
        }
      });
      proposals.push(proposal);
      const outgoing = replyTo ? `[CQ:reply,id=${replyTo}]${text}` : text;
      results.push(
        await runOutbound(proposal, () =>
          target.kind === "group"
            ? connector.sendGroupMessage({ groupId: target.id, text: outgoing })
            : connector.sendPrivateMessage({ userId: target.id, text: outgoing })
        )
      );
    }
    const stopped = results.some(
      (result) => result.status === "result_unknown"
    );
    if (stickerId && !stopped) {
      const proposal = ActionProposalSchema.parse({
        id: randomUUID(),
        proposedAt: clock.now().toISOString(),
        toolName: "say",
        params: {
          conversation: target,
          stickerId,
          ...(replyTo && !text ? { replyTo } : {})
        }
      });
      proposals.push(proposal);
      const stickers = dependencies.stickers;
      results.push(
        await runOutbound(proposal, async () => {
          if (!stickers) {
            return { ok: false, error: "You have no stickers." };
          }
          return stickers.send({
            conversation: target,
            stickerId,
            ...(replyTo && !text ? { replyToMessageId: replyTo } : {}),
            agentTraceId: id
          });
        })
      );
    }
    toolResults.push(...results);
    const failed = results.find((result) => result.status !== "executed");
    return {
      output: failed
        ? {
            status: failed.status,
            reason: failed.reason ?? failed.result?.error ?? "It did not send."
          }
        : {
            status: "sent",
            message_ids: results.flatMap(
              (result) => result.result?.externalId ?? []
            )
          },
      ...(results.some((result) => result.status === "result_unknown")
        ? { stop: true }
        : {})
    };
  };

  const react = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    if (!conversation) {
      return {
        output: { status: "refused", reason: "There is nothing to react to here." }
      };
    }
    const target = conversation;
    const messageId = readString(args.message_id) ?? "";
    const emoji = readString(args.emoji) ?? "";
    const emojiId = REACTION_EMOJIS[emoji];
    if (!emojiId) {
      return {
        output: {
          status: "failed",
          reason: `Unknown emoji. Use one of: ${REACTION_EMOJI_NAMES.join(", ")}`
        }
      };
    }
    if (
      !recordsOf(target).some(
        (record) =>
          isMessageRecord(record) &&
          record.event.message.id === messageId
      )
    ) {
      return {
        output: { status: "failed", reason: `No message ${messageId} here.` }
      };
    }
    const proposal = ActionProposalSchema.parse({
      id: randomUUID(),
      proposedAt: clock.now().toISOString(),
      toolName: "react",
      params: { conversation: target, messageId, emoji }
    });
    proposals.push(proposal);
    const result = await runOutbound(proposal, () =>
      connector.reactToMessage({ messageId, emojiId })
    );
    toolResults.push(result);
    return {
      output:
        result.status === "executed"
          ? { status: "done" }
          : { status: result.status, reason: result.reason ?? result.result?.error },
      ...(result.status === "result_unknown" ? { stop: true } : {})
    };
  };

  const sleep = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    const seconds =
      typeof args.seconds === "number" ? args.seconds : config.defaultSleepSeconds;
    if (place === DREAM_PLACE) {
      const violations = await life.findSizeViolations({
        meMaxBytes: config.meMaxBytes,
        placeMaxBytes: config.placeMaxBytes
      });
      if (violations.length > 0) {
        return {
          output: {
            status: "refused",
            reason: `Too much to carry: ${violations
              .map((item) => `${item.path} is ${item.bytes} bytes, limit ${item.limit}`)
              .join("; ")}. Rewrite it shorter before you sleep.`
          }
        };
      }
    }
    const note = readString(args.note);
    sleepRequest = {
      seconds,
      ...(note ? { note } : {}),
      doNotDisturb: args.do_not_disturb === true
    };
    return { output: { status: "asleep" }, stop: true };
  };

  const runBash = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    const command = readString(args.command);
    if (!command) {
      return { output: { status: "failed", reason: "bash needs a command." } };
    }
    const result = await shell().exec(command);
    return {
      output: {
        stdout: truncateText(result.stdout),
        stderr: truncateText(result.stderr),
        exitCode: result.exitCode
      }
    };
  };

  const execute = async (
    toolName: ToolName,
    args: Record<string, unknown>
  ): Promise<ToolOutcome> => {
    const proposal = toTraceProposal(toolName, args, clock.now(), conversation);
    const isOutboundTool = toolName === "say" || toolName === "react";
    if (proposal && !isOutboundTool) {
      proposals.push(proposal);
      await rollout.recordToolStarted(proposal, false);
    }
    let outcome: ToolOutcome;
    try {
      outcome = await dispatch(toolName, args);
    } catch (error) {
      outcome = { output: { status: "failed", reason: errorMessage(error) } };
    }
    if (proposal && !isOutboundTool) {
      await rollout.recordToolFinished(
        proposal,
        {
          proposal,
          status: "executed",
          result: { ok: true, data: outcome.output },
          executedAt: clock.now().toISOString()
        },
        false
      );
    }
    return outcome;
  };

  const dispatch = async (
    toolName: ToolName,
    args: Record<string, unknown>
  ): Promise<ToolOutcome> => {
    switch (toolName) {
      case "look":
        return look({
          ...(readString(args.place) ? { place: readString(args.place) } : {}),
          ...(readString(args.before) ? { before: readString(args.before) } : {}),
          ...(readString(args.search) ? { search: readString(args.search) } : {}),
          ...(readString(args.image) ? { image: readString(args.image) } : {}),
          ...(readString(args.message_id)
            ? { messageId: readString(args.message_id) }
            : {})
        } as Extract<ActionProposal, { toolName: "look" }>["params"]);
      case "say":
        return say(args);
      case "react":
        return react(args);
      case "sleep":
        return sleep(args);
      case "bash":
        return runBash(args);
    }
  };

  let status: WakeResult["status"] = "completed";
  let failure: string | undefined;
  let usage: ModelUsageTotals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  try {
    dependencies.onPhase("working");
    const instructions = renderLifeSystemPrompt({
      constitution: await life.readConstitution(),
      me: await life.readMe()
    });
    const opening = input.dream
      ? createRenderedPrompt(
          "runtime.life.dream",
          await enterDream()
        )
      : renderWakePrompt(
          await buildWakeOpening(dependencies, input, clock.now())
        );
    const session = dependencies.model.createSession({
      exchangeSink: rollout.exchangeSink
    });
    const purpose = (): ModelExchangePurpose =>
      place === DREAM_PLACE ? "dreaming" : "agent_action";
    const result = await session.run({
      instructions,
      opening,
      tools: dependencies.tools,
      execute,
      maxSteps: input.dream ? config.dreamMaxSteps : config.wakeMaxSteps,
      unfinished: renderUnfinishedPrompt(),
      purpose,
      providerSessionId: `life-${dateInDay(clock.now(), config.dayStartHour, timezone)}`
    });
    usage = result.usage;
  } catch (error) {
    status = "failed";
    failure = errorMessage(error);
    const steps = readModelStepsFromError(error);
    for (const step of steps ?? []) {
      const stepUsage = step.response?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      usage.inputTokens += stepUsage?.inputTokens ?? 0;
      usage.outputTokens += stepUsage?.outputTokens ?? 0;
    }
  }

  const finished = await finishWake();
  return finished;

  async function finishWake(): Promise<WakeResult> {
    const wasDream = place === DREAM_PLACE;
    let reverted = false;
    // A wake that broke before it answered has not really read anything, or a
    // call it never got to would look handled forever.
    if (status === "failed" && said === 0) {
      state.lastRead = lastReadAtStart;
    }
    if (wasDream) {
      const violations = await life.findSizeViolations({
        meMaxBytes: config.meMaxBytes,
        placeMaxBytes: config.placeMaxBytes
      });
      if (status === "failed" || violations.length > 0) {
        await life.revertUncommitted();
        reverted = true;
      }
    }

    const endedAt = clock.now();
    const note = sleepRequest?.note;
    // A wake that went nowhere has nothing to remember. The note is what it
    // chose to keep; what it said is on the record whether it likes it or not,
    // so a dream can hold its words against its life.
    if (place && !wasDream && (note || saidTexts.length > 0)) {
      await life.appendDiary(
        place,
        dateInDay(endedAt, config.dayStartHour, timezone),
        [
          `- ${formatZonedDateTime(endedAt, timezone).time} ${(note ?? "").replace(/\r?\n/g, " ")}`.trimEnd(),
          ...saidTexts.map(
            (text) => `  said: ${text.replace(/\r?\n/g, " ").slice(0, 200)}`
          )
        ].join("\n")
      );
    }
    let commit: string | undefined;
    try {
      commit = await life.commit(
        `${wasDream ? "dream" : place ?? "phone"}: ${note ?? input.reason}`.slice(0, 200),
        endedAt
      );
    } catch (error) {
      publishFailure(dependencies, "life_commit_failed", error);
    }

    if (bash) {
      try {
        await bash.dispose();
      } catch (error) {
        publishFailure(dependencies, "wake_bash_dispose_failed", error);
      }
    }
    if (conversation) {
      sessionStore.unpinConversation(conversation);
    }
    await rollout.close(status, failure);
    dependencies.liveEvents?.publish("rollout.recorded", {
      rolloutId: rollout.id,
      ...(conversation
        ? { conversationKey: getConversationKey(conversation) }
        : {}),
      status
    });

    const eventIds = Array.from(new Set(windowEventIds));
    if (conversation && windowIds.length > 0 && eventIds.length > 0) {
      await sessionStore.recordTurn({
        id,
        rolloutId: rollout.id,
        conversation,
        status,
        startedAt,
        endedAt: endedAt.toISOString(),
        windowIds,
        eventIds,
        steerCount: 0,
        phases: [],
        proposedActions: proposals,
        toolResults
      });
    }

    return {
      id,
      rolloutId: rollout.id,
      reason: input.reason,
      kind: wasDream ? "dream" : "day",
      ...(place ? { place } : {}),
      status,
      startedAt,
      endedAt: endedAt.toISOString(),
      ...(sleepRequest ? { requestedSleepSeconds: sleepRequest.seconds } : {}),
      doNotDisturb: sleepRequest?.doNotDisturb ?? false,
      ...(note ? { note } : {}),
      said,
      held,
      usage,
      proposals,
      toolResults,
      ...(commit ? { commit } : {}),
      reverted,
      ...(failure ? { error: failure } : {})
    };
  }
}

async function buildWakeOpening(
  dependencies: WakeDependencies,
  input: WakeInput,
  now: Date
): Promise<Parameters<typeof renderWakePrompt>[0]> {
  const { config, life, timezone } = dependencies;
  const { state } = input;
  const phone = readPhone({
    sessionStore: dependencies.sessionStore,
    state,
    allowedGroupIds: dependencies.allowedGroupIds
  });
  const local = formatZonedDateTime(now, timezone);
  const memory = await life.readPlaceMemory(WEB_PLACE);
  const diary = await life.readRecentDiary(
    WEB_PLACE,
    recentDates(now, config, timezone)
  );
  return {
    time: `${local.date} ${local.time}, ${local.weekday} (${timezone})`,
    ...(state.lastSleptAt
      ? { sleptFor: formatDuration(now.valueOf() - Date.parse(state.lastSleptAt)) }
      : {}),
    reason: describeWakeReason(input.reason),
    budgetLeftPercent: Math.max(
      0,
      Math.round(
        100 * (1 - state.budget.usedTokens / config.dailyTokenBudget)
      )
    ),
    lastDream: `${formatDuration(now.valueOf() - Date.parse(state.lastDreamAt))} ago`,
    phone: phone.places
      .filter((entry) => entry.unread > 0 || entry.called)
      .map((entry) => ({
        place: entry.place,
        kind: entry.conversation.kind,
        ...(entry.conversation.name ? { name: entry.conversation.name } : {}),
        unread: entry.unread,
        called: entry.called,
        ...(entry.lastMessageAt
          ? {
              lastMessageTime: formatZonedDateTime(
                new Date(entry.lastMessageAt),
                timezone
              ).time
            }
          : {})
      })),
    web: [...memory.map((file) => file.content), diary]
      .filter((value) => value.trim())
      .join("\n"),
    emojis: REACTION_EMOJI_NAMES
  };
}

function describeWakeReason(reason: WakeReason): string {
  switch (reason) {
    case "vibration":
      return "your phone buzzed, someone called you";
    case "boot":
      return "you just came back online";
    default:
      return "you meant to wake around now";
  }
}

async function renderDreamOpening(
  life: LifeStore,
  lastDreamAt: string,
  now: Date,
  timezone: string,
  reason: string | undefined
): Promise<string> {
  const since = formatZonedDateTime(new Date(lastDreamAt), timezone).date;
  const entries = await life.readDiariesSince(since);
  const inline: typeof entries = [];
  let chars = 0;
  for (const entry of entries.slice().reverse()) {
    if (chars + entry.content.length > MAX_INLINE_DIARY_CHARS) {
      break;
    }
    chars += entry.content.length;
    inline.unshift(entry);
  }
  return renderDreamPrompt({
    ...(reason ? { reason } : {}),
    lastDream: `${formatDuration(now.valueOf() - Date.parse(lastDreamAt))} ago`,
    diaries: inline,
    omittedDiaries: entries.length - inline.length,
    archive: await life.hasArchive()
  });
}

function recentDates(
  now: Date,
  config: LifeConfig,
  timezone: string
): string[] {
  const dates: string[] = [];
  for (let offset = DIARY_DAYS - 1; offset >= 0; offset -= 1) {
    dates.push(
      dateInDay(
        new Date(now.valueOf() - offset * 86_400_000),
        config.dayStartHour,
        timezone
      )
    );
  }
  return dates;
}

function toTraceProposal(
  toolName: ToolName,
  args: Record<string, unknown>,
  now: Date,
  conversation: Conversation | undefined
): ActionProposal | undefined {
  const base = { id: randomUUID(), proposedAt: now.toISOString() };
  const parsed = ActionProposalSchema.safeParse(
    toolName === "look"
      ? {
          ...base,
          toolName,
          params: {
            ...optional("place", args.place),
            ...optional("before", args.before),
            ...optional("search", args.search),
            ...optional("image", args.image),
            ...optional("messageId", args.message_id)
          }
        }
      : toolName === "sleep"
        ? {
            ...base,
            toolName,
            params: {
              seconds: args.seconds ?? 0,
              ...optional("note", args.note),
              ...(args.do_not_disturb === true ? { doNotDisturb: true } : {})
            }
          }
        : toolName === "bash"
          ? { ...base, toolName, params: { command: args.command } }
          : { ...base, toolName, params: { conversation, ...args } }
  );
  return parsed.success ? parsed.data : undefined;
}

function optional(key: string, value: unknown): Record<string, unknown> {
  return typeof value === "string" && value ? { [key]: value } : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateText(value: string): string {
  return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n...(truncated)`;
}

function truncateData(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json && json.length > 4_000 ? { preview: json.slice(0, 4_000) } : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishFailure(
  dependencies: WakeDependencies,
  code: string,
  error: unknown
): void {
  dependencies.liveEvents?.publish("agent.run.failed", {
    entity: { kind: "signal", id: code },
    status: "failed",
    summary: errorMessage(error)
  });
}

export { isVisibleSideEffect, isSelfMessageEvent };
