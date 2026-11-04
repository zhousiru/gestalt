import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createLiveEventBus,
  createLiveRunStore,
  createMockConnector,
  createRuntime,
  createScriptedModel,
  createVirtualClock,
  startLiveDebugServer
} from "@gestalt/app";
import {
  ConversationTimelinePageSchema,
  ConversationsPageSchema,
  LiveOverviewSchema,
  ModelInputResponseSchema,
  RolloutDetailSchema,
  RolloutsPageSchema
} from "@gestalt/live-contracts";
import { writeArtifactJson } from "./artifactBinary";
import { startLifeSimulation } from "./replayRunner";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const holdOpen = process.argv.includes("--hold");
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "traces-ui"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-traces-ui-"));
await cp(
  path.join(repoRoot, "harness", "fixtures", "homes", "simple-group-test"),
  tempHome,
  { recursive: true }
);
const clock = createVirtualClock("2026-07-12T11:20:00.000Z");
const now = clock.now;
const bus = createLiveEventBus({ now });
const runStore = createLiveRunStore(bus);
const connector = createMockConnector({ now });
const runtime = await createRuntime({
  gestaltHome: tempHome,
  connector,
  model: createScriptedModel({
    now,
    script({ wake, step }) {
      const steps = [
        [{ toolName: "sleep" as const, input: { seconds: 7200 } }],
        [
          {
            toolName: "look" as const,
            input: { place: "group-trace-ui-group" }
          },
          {
            toolName: "say" as const,
            input: { text: "在，我看到了。", reply_to: "trace-ui-message-1" }
          },
          { toolName: "sleep" as const, input: { seconds: 7200 } }
        ]
      ][wake - 1];
      return steps?.[step];
    }
  }),
  liveEvents: bus,
  clock
});
const simulation = await startLifeSimulation({
  clock,
  createRuntime: async () => runtime
});
const port = await findAvailablePort();
const server = await startLiveDebugServer({
  runtime,
  bus,
  runStore,
  host: "127.0.0.1",
  port,
  uiDir: path.join(repoRoot, "packages", "trace", "dist"),
  now
});

try {
  const event = connector.createMessageEvent({
    conversationId: "trace-ui-group",
    conversationName: "Trace UI Contract Group",
    senderId: "alice",
    senderName: "Alice",
    messageId: "trace-ui-message-1",
    text: "gestalt 验证 rollout-first API",
    mentionsBot: true
  });
  event.id = "trace-ui-event-1";
  await simulation.advanceTo(clock.now().valueOf() + 1_000);
  await runtime.dispatchEvent(event);
  await simulation.advanceTo(clock.now().valueOf() + 60_000);
  assert.equal(
    runtime.loop.wakes.at(-1)?.said,
    1,
    "fixture should complete one wake that speaks"
  );
  await runtime.flush();

  const overview = LiveOverviewSchema.parse(
    await fetchJson(`${server.url}/api/live/overview`)
  );
  assert.equal(overview.binaryCaptureEnabled, false);
  assert.ok(overview.counts.conversations >= 1);
  assert.ok(overview.counts.rollouts >= 1);

  const conversations = ConversationsPageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/conversations?limit=1&query=${encodeURIComponent("Contract Group")}`
    )
  );
  assert.equal(conversations.items.length, 1);
  const conversation = conversations.items[0];
  assert.ok(conversation);
  assert.equal(conversation.key, "group:trace-ui-group");

  const timeline = ConversationTimelinePageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/conversations/${encodeURIComponent(conversation.key)}/timeline?limit=1`
    )
  );
  assert.equal(timeline.conversation.key, conversation.key);
  assert.equal(timeline.items.length, 1);

  await simulation.advanceTo(clock.now().valueOf() + 1_000);
  const liveEvent = connector.createMessageEvent({
    conversationId: "trace-ui-group",
    conversationName: "Trace UI Contract Group",
    senderId: "bob",
    senderName: "Bob",
    messageId: "trace-ui-live-contract",
    text: "live update without page refresh",
    mentionsBot: false
  });
  await runtime.ingestEvent(liveEvent);
  const liveConversations = ConversationsPageSchema.parse(
    await fetchJson(`${server.url}/api/live/conversations?limit=1`)
  );
  assert.equal(liveConversations.items[0]?.lastText, liveEvent.message.text);
  assert.equal(liveConversations.items[0]?.messageCount, 3);
  const liveTimeline = ConversationTimelinePageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/conversations/${encodeURIComponent(conversation.key)}/timeline?limit=10`
    )
  );
  assert.ok(
    liveTimeline.items.some(
      (item) => item.type === "message" && item.messageId === liveEvent.message.id
    ),
    "newly committed in-memory message must be visible before the journal batch flushes"
  );

  const rolloutPage = RolloutsPageSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts?limit=1&status=completed&conversation=${encodeURIComponent("group:trace-ui-group")}`
    )
  );
  assert.equal(rolloutPage.items.length, 1);
  const rolloutSummary = rolloutPage.items[0];
  assert.ok(rolloutSummary);

  const rollout = RolloutDetailSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}`
    )
  );
  assert.equal(rollout.summary.id, rolloutSummary.id);
  assert.ok(rollout.modelSession.initialMessageCount >= 1);
  assert.equal(
    rollout.generations.length,
    3,
    "fixture must exercise the model step navigation and continuous call path"
  );
  assert.ok(
    rollout.records.some((record) => record.type === "rollout_finished")
  );
  const generation = rollout.generations[0];
  assert.ok(generation);
  const generationDeltas = await Promise.all(
    rollout.generations.map((item) =>
      fetchJson(
        `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}/model-input?generationId=${encodeURIComponent(item.id)}&view=delta`
      ).then((value) => ModelInputResponseSchema.parse(value))
    )
  );
  assert.deepEqual(
    generationDeltas.map((item) => item.generationId),
    rollout.generations.map((item) => item.id)
  );
  assert.ok(
    generationDeltas.every((item) => item.messages.length > 0),
    "every fixture step must contribute visible path content"
  );

  const deltaInput = ModelInputResponseSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}/model-input?generationId=${encodeURIComponent(generation.id)}&view=delta`
    )
  );
  const fullInput = ModelInputResponseSchema.parse(
    await fetchJson(
      `${server.url}/api/live/rollouts/${encodeURIComponent(rolloutSummary.id)}/model-input?generationId=${encodeURIComponent(generation.id)}&view=full`
    )
  );
  assert.equal(deltaInput.stateHash, generation.inputStateHash);
  assert.equal(fullInput.stateHash, generation.inputStateHash);
  assert.equal(fullInput.messages.length, fullInput.messageCount);
  assert.ok(fullInput.tools && fullInput.tools.length > 0);

  const binaryResponse = await fetch(
    `${server.url}/api/live/blobs/${"a".repeat(64)}`
  );
  assert.equal(binaryResponse.status, 404);
  assert.match(await binaryResponse.text(), /Binary capture is disabled/);

  const invalidPage = await fetch(
    `${server.url}/api/live/rollouts?limit=201`
  );
  assert.equal(invalidPage.status, 400);

  const uiResponse = await fetch(server.url);
  assert.equal(uiResponse.status, 200);
  assert.match(
    uiResponse.headers.get("content-type") ?? "",
    /^text\/html(?:;|$)/
  );

  const artifact = {
    ok: true,
    overview,
    conversation,
    timelineItems: timeline.items.length,
    liveUpdate: {
      lastText: liveConversations.items[0]?.lastText,
      messageCount: liveConversations.items[0]?.messageCount,
      timelineVisible: true
    },
    rollout: rollout.summary,
    recordTypes: rollout.records.map((record) => record.type),
    generationIds: rollout.generations.map((item) => item.id),
    deltaMessageCounts: generationDeltas.map((item) => item.messages.length),
    fullMessageCount: fullInput.messages.length,
    binaryDisabledStatus: binaryResponse.status,
    invalidPageStatus: invalidPage.status
  };
  await mkdir(artifactDir, { recursive: true });
  await writeArtifactJson(path.join(artifactDir, "result.json"), artifact);
  console.log(JSON.stringify({ ...artifact, artifactDir }, null, 2));
  if (holdOpen) {
    console.log(`Trace UI preview: ${server.url}`);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (input) => {
      if (String(input).trim() !== "update") return;
      void appendLiveUpdate();
    });
    await waitForShutdownSignal();
  }
} finally {
  await simulation.finish();
  await server.close();
  runStore.dispose();
  await rm(tempHome, { recursive: true, force: true });
}

async function appendLiveUpdate(): Promise<void> {
  clock.advanceTo(clock.now().valueOf() + 1_000);
  const event = connector.createMessageEvent({
    conversationId: "trace-ui-group",
    conversationName: "Trace UI Contract Group",
    senderId: "bob",
    senderName: "Bob",
    messageId: `trace-ui-live-${clock.now().valueOf()}`,
    text: `live update ${clock.now().toISOString()}`,
    mentionsBot: false
  });
  await runtime.ingestEvent(event);
  console.log(`Trace UI live update appended: ${event.message.id}`);
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `${url} returned ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
}

async function findAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
