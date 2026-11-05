import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import {
  createAiSdkModel,
  createMockConnector,
  createRuntime,
  createVirtualClock,
  resolveGestaltHome,
  type Runtime
} from "@gestalt/app";
import { startLifeSimulation } from "./replayRunner";

// The scripted model never touches the AI SDK, so what only goes wrong in a real
// session lives here: an image has to stay in the context after the step that
// opened it, and a wake that breaks must not swallow the call it was answering.
type Generated = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type Step = { tool: string; input: unknown } | { text: string } | { fail: string };

const PLACE = "group-123456";
const IMAGE = "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const script: Step[] = [
  { tool: "sleep", input: { seconds: 3600 } },
  // Opens an image, stops without a tool, and answers once it is nudged.
  { tool: "look", input: { place: PLACE } },
  { tool: "look", input: { place: PLACE, image: "cat.png" } },
  { text: "是只猫" },
  { tool: "say", input: { text: "是只猫" } },
  { tool: "sleep", input: { seconds: 3600 } },
  // Breaks after reading a call, before it answered.
  { tool: "look", input: { place: PLACE } },
  { fail: "provider fell over" },
  { tool: "look", input: { place: PLACE } },
  { tool: "say", input: { text: "刚才断了一下" } },
  { tool: "sleep", input: { seconds: 3600 } }
];

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(path.join(os.tmpdir(), "gestalt-wake-model-"));
const start = new Date("2026-11-05T06:00:00.000Z");
const startMs = start.valueOf();

try {
  await cp(path.join(repoRoot, "harness/fixtures/homes/simple-group-test"), root, {
    recursive: true
  });
  const clock = createVirtualClock(start);
  const connector = createMockConnector({ now: clock.now });
  connector.readImage = async ({ file }) => ({
    ok: true,
    externalId: file,
    data: { file },
    media: { source: "connector-action", kind: "base64", value: IMAGE }
  });

  const requests: string[] = [];
  let toolCalls = 0;
  const languageModel = new MockLanguageModelV4({
    async doGenerate({ prompt }) {
      requests.push(JSON.stringify(prompt));
      const step = script[requests.length - 1];
      assert.ok(step, `unexpected model request ${requests.length}`);
      if ("fail" in step) {
        throw new Error(step.fail);
      }
      toolCalls += 1;
      return generated(
        "text" in step
          ? [{ type: "text", text: step.text }]
          : [
              {
                type: "tool-call",
                toolCallId: `call-${toolCalls}`,
                toolName: step.tool,
                input: JSON.stringify(step.input)
              }
            ],
        "text" in step ? "stop" : "tool-calls"
      );
    }
  });

  let runtime: Runtime | undefined;
  const simulation = await startLifeSimulation({
    clock,
    createRuntime: async () =>
      (runtime = await createRuntime({
        gestaltHome: root,
        connector,
        clock,
        model: createAiSdkModel({
          languageModel,
          modelName: "mock",
          now: clock.now
        })
      }))
  });
  const call = async (at: number, messageId: string, text: string) => {
    await simulation.advanceTo(startMs + at * 1000);
    await runtime?.dispatchEvent(
      connector.createMessageEvent({
        conversationKind: "group",
        conversationId: "123456",
        conversationName: "测试群",
        senderId: "alice",
        senderName: "Alice",
        messageId,
        text,
        mentionsBot: true
      })
    );
  };

  await call(10, "m1", "@小格 看看这张图");
  await call(200, "m2", "@小格 还在吗");
  await simulation.advanceTo(startMs + 600 * 1000);
  const wakes = [...(runtime?.loop.wakes ?? [])];
  await simulation.finish();

  assert.deepEqual(
    wakes.map((wake) => wake.status),
    ["completed", "completed", "failed", "completed"],
    JSON.stringify(wakes.map(({ reason, error }) => ({ reason, error })))
  );

  const opened = requests.slice(3, 6);
  assert.equal(opened.length, 3);
  for (const request of opened) {
    assert.ok(
      request.includes('"type":"file"'),
      "the image stays in the context after the step that opened it"
    );
  }
  assert.ok(
    (requests[4] ?? "").indexOf('"type":"file"') <
      (requests[4] ?? "").indexOf("是只猫"),
    "the image keeps its place before what the model said about it"
  );
  assert.deepEqual(
    connector.sentGroupMessages.map((message) => message.input.text),
    ["是只猫", "刚才断了一下"]
  );
  assert.match(
    requests.at(-2) ?? "",
    /还在吗/,
    "a call the failed wake never answered is still unread"
  );

  const home = await resolveGestaltHome({ homePath: root, create: false });
  const diaryDir = path.join(root, "life", "places", PLACE, "diary");
  const diary = (
    await Promise.all(
      (await readdir(diaryDir)).map((file) =>
        readFile(path.join(diaryDir, file), "utf8")
      )
    )
  ).join("");
  assert.match(diary, /said: 是只猫/, "what it said is on the record");
  assert.match(diary, /said: 刚才断了一下/, "without a note, too");
  const terminal = await rolloutTerminals(home.tracesDir);
  assert.deepEqual(
    [...terminal].sort(),
    ["completed", "completed", "completed", "failed"],
    "every wake closes its rollout, even the one that broke"
  );
  console.log("wakeModel.verify passed");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

function generated(
  content: Generated["content"],
  finishReason: "stop" | "tool-calls"
): Generated {
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: undefined,
        cacheWrite: undefined
      },
      outputTokens: { total: 5, text: 5, reasoning: undefined }
    },
    warnings: []
  };
}

async function rolloutTerminals(tracesDir: string): Promise<string[]> {
  const entries = await readdir(tracesDir, { recursive: true, withFileTypes: true });
  const statuses: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const rows = (await readFile(path.join(entry.parentPath, entry.name), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; status?: string });
    const finished = rows.find((row) => row.type === "rollout_finished");
    assert.ok(finished, `${entry.name} was left open`);
    statuses.push(finished.status ?? "unknown");
  }
  return statuses;
}
