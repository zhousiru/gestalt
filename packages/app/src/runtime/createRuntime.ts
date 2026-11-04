import {
  CanonicalEventSchema,
  type CanonicalEvent
} from "../events/schemas";
import { isSelfMessageEvent } from "../events/helpers";
import { createMockConnector } from "../connectors/mock/connector";
import type { Connector, ConnectorCallResult } from "../connectors/types";
import { resolveTimezone } from "../context/time";
import { loadEnv } from "../home/loadEnv";
import { loadConfig, type GestaltConfig } from "../home/loadConfig";
import {
  resolveGestaltHome,
  type GestaltHome
} from "../home/resolveGestaltHome";
import {
  createAiSdkInspectRunner,
  parseInspectCommand,
  type InspectRunner
} from "../inspect/agent";
import { createSystemClock, type LifeClock } from "../life/clock";
import { readBotIdentity, readLifeConfig } from "../life/config";
import { createLifeLoop, type LifeLoop } from "../life/loop";
import { createLifeStore, type LifeStore } from "../life/store";
import type { LiveEventSink } from "../live/viewTypes";
import { createScriptedModel, type ModelClient } from "../model/session";
import {
  createInMemorySessionStore,
  getConversationKey,
  type ExportSessionDiagnosticsOptions,
  type SessionStore
} from "../session/store";
import { createSessionRecorder } from "../session/recorder";
import {
  createRecentSessionEventAppender,
  createSessionHistoryReader,
  hydrateRecentSessionMessages,
  type SessionHistoryReader
} from "../session/history";
import {
  type SessionEventRecord,
  type SessionDiagnostics
} from "../session/schemas";
import {
  createRolloutReader,
  type RolloutReader
} from "../rollout";
import {
  createConfiguredStickerService,
  isStickerSubsystemConfigured,
  readOperatorUserIds,
  readStickerScrapingEnabled
} from "../stickers/integration";
import type { StickerService } from "../stickers/service";
import type { NativeCommandTarget } from "../tools/agentBrowser";
import { createDefaultToolRegistry } from "../tools/registry";
import type { ToolDefinition } from "../tools/schemas";
import { commitOutboundMessage } from "./outboundMessages";

export interface Runtime {
  home: GestaltHome;
  life: LifeStore;
  loop: LifeLoop;
  stickers?: StickerService;
  sessionStore: SessionStore;
  sessionHistory: SessionHistoryReader;
  rolloutReader: RolloutReader;
  ingestEvent(event: unknown): Promise<SessionEventRecord>;
  /** Journals an event and lets the life loop notice it. Never waits on a wake. */
  dispatchEvent(event: unknown): Promise<void>;
  startLife(): void;
  exportDiagnostics(options?: ExportSessionDiagnosticsOptions): SessionDiagnostics;
  /** Stops the life loop and flushes everything durable. */
  shutdown(): Promise<void>;
  flush(): Promise<void>;
}

export interface CreateRuntimeOptions {
  gestaltHome?: string;
  connector?: Connector;
  model?: ModelClient;
  tools?: ToolDefinition[];
  agentBrowserTarget?: NativeCommandTarget;
  inspectRunner?: InspectRunner;
  liveEvents?: LiveEventSink;
  stickerService?: StickerService;
  clock?: LifeClock;
  now?: () => Date;
}

export async function createRuntime(
  options: CreateRuntimeOptions = {}
): Promise<Runtime> {
  const clock = options.clock ?? createSystemClock(options.now);
  const now = clock.now;
  const home = await resolveGestaltHome(
    options.gestaltHome ? { homePath: options.gestaltHome } : {}
  );
  loadEnv(home);
  const config = await loadConfig(home);
  const resolvedTimezone = resolveTimezone(config);
  const inspectRunner = options.inspectRunner ?? createAiSdkInspectRunner(config);
  const tools = options.tools ?? createDefaultToolRegistry();
  const connector = options.connector ?? createMockConnector();
  readStickerScrapingEnabled(config);
  const stickerService =
    options.stickerService ??
    (isStickerSubsystemConfigured(config)
      ? await createConfiguredStickerService({
          home,
          config,
          connector,
          ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}),
          now
        })
      : undefined);
  const operatorUserIds = readOperatorUserIds(config);
  const model =
    options.model ??
    createScriptedModel({
      now,
      script: () => ({ toolName: "sleep", input: { seconds: 3600 } })
    });
  const sessionRecorder = createSessionRecorder(home);
  const sessionStore = createInMemorySessionStore({
    now,
    onJournalRecord: (record) => sessionRecorder.enqueue(record),
    onEventAppended(record) {
      options.liveEvents?.publish(
        "session.event.appended",
        {
          conversationKey: getConversationKey(record.event.conversation),
          eventId: record.event.id,
          recordId: record.id
        },
        record.receivedAt
      );
    },
    onWindowCreated(window) {
      options.liveEvents?.publish(
        "session.window.created",
        {
          conversationKey: getConversationKey(window.conversation),
          windowId: window.id
        },
        window.closedAt
      );
    },
    onTurnRecorded(turn) {
      options.liveEvents?.publish(
        "session.turn.recorded",
        {
          conversationKey: getConversationKey(turn.conversation),
          turnId: turn.id,
          rolloutId: turn.rolloutId
        },
        turn.endedAt
      );
    }
  });
  const sessionHistory = createSessionHistoryReader(home);
  const rolloutReader = createRolloutReader({ tracesDir: home.tracesDir });
  await hydrateRecentSessionMessages({
    home,
    config,
    store: sessionStore,
    reader: sessionHistory,
    now
  });
  const sessionEventAppender = createRecentSessionEventAppender({
    config,
    store: sessionStore,
    reader: sessionHistory,
    now
  });
  const allowedGroupIds = readAllowedGroupIds(config);
  const life = createLifeStore({
    home,
    authorName: readBotIdentity(config).displayName
  });
  const loop = createLifeLoop({
    home,
    gestaltConfig: config,
    config: readLifeConfig(config),
    life,
    clock,
    timezone: resolvedTimezone.timezone,
    tools,
    sessionStore,
    sessionHistory,
    connector,
    model,
    allowedGroupIds,
    stickers: stickerService,
    ...(options.agentBrowserTarget
      ? { agentBrowserTarget: options.agentBrowserTarget }
      : {}),
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}),
    async commitOutbound({ sourceEvent, proposal, result }) {
      await commitOutboundMessage({
        config,
        sourceEvent,
        proposal,
        result,
        appendEvent: (event, appendOptions) =>
          sessionEventAppender.appendEvent(event, appendOptions),
        flushDurable: () => sessionRecorder.flush({ durable: true })
      });
    }
  });

  const appendParsedEvent = (
    parsedEvent: CanonicalEvent
  ): Promise<SessionEventRecord> =>
    sessionEventAppender.appendEvent(parsedEvent, {
      receivedAt: now().toISOString()
    });

  async function dispatchEvent(event: unknown): Promise<void> {
    const parsedEvent = CanonicalEventSchema.parse(event);
    if (!isAllowedGroupEvent(parsedEvent, allowedGroupIds)) {
      return;
    }

    sessionStore.pinConversation(parsedEvent.conversation);
    try {
      const record = await appendParsedEvent(parsedEvent);
      if (await handleOperatorCommand(record)) {
        return;
      }
      if (stickerService && parsedEvent.type === "MessageReceived") {
        try {
          // Session storage intentionally retains only its sanitized journal
          // representation. Sticker extraction gets the transient connector
          // event so source segments are usable without pinning transport media
          // in the bounded SessionStore.
          await stickerService.observe(parsedEvent);
        } catch (error) {
          try {
            options.liveEvents?.publish("sticker.job.updated", {
              sourceEventId: parsedEvent.id,
              error: error instanceof Error ? error.message : String(error)
            });
          } catch {
            // Sticker Live events are diagnostics and must not interrupt
            // ordinary message ingestion when their sink is unavailable.
          }
        }
      }
      loop.notice(record);
    } finally {
      sessionStore.unpinConversation(parsedEvent.conversation);
    }
  }

  /** Operator commands act on the runtime directly and never enter a wake. */
  async function handleOperatorCommand(
    record: SessionEventRecord
  ): Promise<boolean> {
    const scrapeCommand = parseScrapeStickerCommand(record.event);
    if (scrapeCommand) {
      const authorized = operatorUserIds.has(
        record.event.type === "MessageReceived" ? record.event.sender.id : ""
      );
      let reply: string;
      if (!authorized) {
        reply = "无权执行该命令";
      } else if (!stickerService) {
        reply = "表情系统未配置 embedding_model_*";
      } else if (scrapeCommand.mode === "invalid") {
        reply = "用法：/scrape-sticker [on|off]";
      } else {
        const context = {
          actorUserId:
            record.event.type === "MessageReceived"
              ? record.event.sender.id
              : "",
          sourceEventId: record.event.id,
          at: now().toISOString()
        };
        const enabled =
          scrapeCommand.mode === "toggle"
            ? await stickerService.toggleScraping(context)
            : await stickerService.setScrapingOverride(
                scrapeCommand.mode === "on",
                context
              );
        reply = enabled ? "表情采集已开启" : "表情采集已关闭";
      }
      const sendResult = await sendControlReply(connector, record.event, reply);
      if (sendResult.ok) {
        await appendControlReply(record, reply, sendResult, "control");
        await sessionRecorder.flush();
      }
      return true;
    }

    if (record.event.type !== "MessageReceived") {
      return false;
    }
    const inspectCommand = parseInspectCommand(record.event);
    if (!inspectCommand) {
      return false;
    }
    await sessionRecorder.flush();
    const result = await inspectRunner.run({
      home,
      config,
      eventRecord: record,
      command: inspectCommand,
      sessionDiagnostics: sessionStore.exportDiagnostics({
        exportedAt: now().toISOString()
      }),
      now
    });
    const text =
      result.reportText ??
      `inspect 没能完成完整诊断。原因：${result.error ?? "unknown error"}`;
    const sendResult = await sendControlReply(connector, record.event, text);
    if (sendResult.ok) {
      await appendControlReply(record, text, sendResult, "inspect");
    }
    await sessionRecorder.flush();
    return true;
  }

  async function appendControlReply(
    record: SessionEventRecord,
    text: string,
    sendResult: ConnectorCallResult,
    kind: "control" | "inspect"
  ): Promise<void> {
    const selfId =
      readOptionalString(config.flatValues, "bot_user_id") ??
      record.event.source.accountId ??
      "gestalt-bot";
    const selfName =
      readOptionalString(config.flatValues, "bot_display_name") ?? "Gestalt";
    const occurredAt = now().toISOString();
    await sessionStore.appendEvent(
      {
        id: `self-${kind}-${record.event.id}`,
        type: "MessageReceived",
        occurredAt,
        source: {
          platform: record.event.source.platform,
          connector: `runtime-${kind}`,
          accountId: selfId,
          rawEventId: sendResult.externalId ?? `${kind}-${record.event.id}`
        },
        conversation: record.event.conversation,
        sender: { id: selfId, displayName: selfName, isSelf: true },
        message: {
          id: sendResult.externalId ?? `self-${kind}-message-${record.event.id}`,
          text,
          rawText: text,
          mentionsBot: false
        },
        raw: {
          generatedBy: `runtime-${kind}`,
          requestEventId: record.event.id
        }
      },
      { receivedAt: occurredAt }
    );
  }

  return {
    home,
    life,
    loop,
    ...(stickerService ? { stickers: stickerService } : {}),
    sessionStore,
    sessionHistory,
    rolloutReader,
    ingestEvent: (event) => appendParsedEvent(CanonicalEventSchema.parse(event)),
    dispatchEvent,
    startLife: () => loop.start(),
    exportDiagnostics: (exportOptions = {}) =>
      sessionStore.exportDiagnostics(exportOptions),

    async flush() {
      await sessionRecorder.flush({ durable: true });
    },

    async shutdown() {
      await loop.stop();
      await sessionRecorder.flush({ durable: true });
      await stickerService?.whenIdle();
    }
  };
}

function isAllowedGroupEvent(
  event: CanonicalEvent,
  allowedGroupIds: Set<string> | undefined
): boolean {
  if (
    !allowedGroupIds ||
    event.type !== "MessageReceived" ||
    event.conversation.kind !== "group"
  ) {
    return true;
  }
  return allowedGroupIds.has(event.conversation.id);
}

type ScrapeStickerCommand = {
  mode: "on" | "off" | "toggle" | "invalid";
};

function parseScrapeStickerCommand(
  event: CanonicalEvent
): ScrapeStickerCommand | undefined {
  if (event.type !== "MessageReceived" || isSelfMessageEvent(event)) {
    return undefined;
  }
  const parts = event.message.text.trim().split(/\s+/);
  if (parts[0] !== "/scrape-sticker") {
    return undefined;
  }
  if (parts.length === 1) {
    return { mode: "toggle" };
  }
  if (parts.length === 2 && (parts[1] === "on" || parts[1] === "off")) {
    return { mode: parts[1] };
  }
  return { mode: "invalid" };
}

async function sendControlReply(
  connector: Connector,
  event: CanonicalEvent,
  text: string
): Promise<ConnectorCallResult> {
  if (event.conversation.kind === "group") {
    return connector.sendGroupMessage({ groupId: event.conversation.id, text });
  }
  return connector.sendPrivateMessage({ userId: event.conversation.id, text });
}

function readAllowedGroupIds(config: GestaltConfig): Set<string> | undefined {
  const value = config.flatValues.allowedgroups;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Config value allowedgroups must be an array of group ids.");
  }
  return new Set(value.map(readAllowedGroupId));
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

function readAllowedGroupId(
  value: string | number | boolean,
  index: number
): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error(`Config value allowedgroups[${index}] must be a group id.`);
}
