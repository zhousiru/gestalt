import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateText, tool } from "ai";
import { config as loadDotenvFile } from "dotenv";
import { z } from "zod";
import {
  createAiSdkModelFromConfig,
  createMockConnector,
  createRuntime,
  createVirtualClock,
  loadConfig,
  resolveGestaltHome,
  type StickerService
} from "@gestalt/app";
import { writeArtifactJson } from "./artifactBinary";
import { loadEvalModelConfig } from "./evalModelConfig";
import { startLifeSimulation } from "./replayRunner";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "stickers-social-eval"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-sticker-eval-"));
const stickerHabit = [
  "我习惯用表情包表达情绪，一张表情能说完的话就不打字。",
  "严肃的事不用表情。"
].join("\n");

for (const fileName of [".env", ".env.local"]) {
  loadDotenvFile({
    path: path.join(repoRoot, fileName),
    override: false,
    quiet: true
  });
}

const JudgmentSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

interface StickerToolCall {
  toolName: "sticker search" | "say sticker";
  params: unknown;
}

try {
  await cp(
    path.join(repoRoot, "harness", "fixtures", "homes", "simple-group-test"),
    tempHome,
    { recursive: true }
  );
  await writeFile(
    path.join(tempHome, "persona", "3-stickers.md"),
    `${stickerHabit}\n`,
    "utf8"
  );
  const home = await resolveGestaltHome({ homePath: tempHome, create: false });
  const config = await loadConfig(home);
  const clock = createVirtualClock("2026-11-05T06:00:00.000Z");
  const connector = createMockConnector({ now: clock.now });
  const stickerCalls: StickerToolCall[] = [];
  const stickerService = {
    configuredEnabled: false,
    isScrapingEnabled: () => false,
    async observe() {
      return undefined;
    },
    async search(input: { query: string }) {
      stickerCalls.push({ toolName: "sticker search", params: input.query });
      return [
        {
          stickerId: "stk_celebration_fixture",
          visual: "A blue character dances with both arms raised."
        }
      ];
    },
    async send(input: { stickerId: string }) {
      stickerCalls.push({ toolName: "say sticker", params: input.stickerId });
      return {
        ok: true,
        externalId: `eval-sticker-${randomUUID()}`,
        data: {
          stickerId: input.stickerId,
          visual: "A blue character dances with both arms raised."
        }
      };
    },
    async whenIdle() {
      return undefined;
    }
  } as unknown as StickerService;
  const runtime = await createRuntime({
    gestaltHome: tempHome,
    connector,
    model: createAiSdkModelFromConfig(config, { now: clock.now }),
    stickerService,
    clock
  });
  const simulation = await startLifeSimulation({
    clock,
    createRuntime: async () => runtime
  });

  const scenarios = [
    {
      id: "celebration",
      text: "小格，今天所有测试终于都绿了，来个合适的表情庆祝一下！"
    },
    {
      id: "follow-up-restraint",
      text: "收到，我们继续安静收尾吧。"
    },
    {
      id: "serious-incident",
      text: "小格，线上疑似发生数据泄露，请先给我一个明确的应急步骤。"
    }
  ] as const;
  const conversation = "group-sticker-social-eval-group";
  for (const scenario of scenarios) {
    await simulation.advanceTo(clock.now().valueOf() + 30 * 60_000);
    const event = connector.createMessageEvent({
      conversationId: "sticker-social-eval-group",
      conversationName: "Sticker Social Eval",
      senderId: "alice",
      senderName: "Alice",
      messageId: `message-${scenario.id}`,
      text: scenario.text,
      mentionsBot: true
    });
    await runtime.dispatchEvent(event);
    await simulation.advanceTo(clock.now().valueOf() + 60_000);
  }
  await simulation.advanceTo(clock.now().valueOf() + 3 * 60 * 60_000);
  const wakes = [...runtime.loop.wakes];
  await simulation.finish();

  const session = runtime.exportDiagnostics({ exportedAt: clock.now().toISOString() });
  const evidence = {
    persona: stickerHabit,
    scenarios,
    wakes: wakes.map((wake) => ({
      reason: wake.reason,
      place: wake.place,
      proposals: wake.proposals.map((proposal) => ({
        toolName: proposal.toolName,
        params: proposal.params
      }))
    })),
    stickerCalls,
    visibleTranscript: session.conversations
      .find((candidate) => `group-${candidate.conversation.id}` === conversation)
      ?.events.map((record) => ({
        sender: record.event.sender.isSelf ? "gestalt" : record.event.sender.id,
        text: record.event.message.text
      }))
  };
  const judgeConfig = await loadEvalModelConfig();
  const judged = await judge(evidence, judgeConfig);

  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeArtifactJson(path.join(artifactDir, "evidence.json"), evidence),
    writeArtifactJson(path.join(artifactDir, "session.json"), session),
    writeArtifactJson(path.join(artifactDir, "judgment.json"), {
      judgeModel: judgeConfig.modelName,
      judgeConfigVersion: judgeConfig.configVersion,
      ...judged
    }),
    writeFile(
      path.join(artifactDir, "report.md"),
      [
        "# Sticker Social Eval",
        "",
        `- Label: ${judged.label}`,
        `- Score: ${judged.score}`,
        `- Judge: ${judgeConfig.modelName}`,
        "",
        judged.summary,
        "",
        "## Reasoning",
        "",
        judged.reasoning,
        "",
        "## Evidence",
        "",
        judged.evidence.map((item) => `- ${item}`).join("\n") || "- none",
        ""
      ].join("\n"),
      "utf8"
    )
  ]);
  console.log(
    JSON.stringify(
      {
        ok: judged.label !== "fail",
        label: judged.label,
        score: judged.score,
        summary: judged.summary,
        stickerCalls: stickerCalls.length,
        artifactDir
      },
      null,
      2
    )
  );
  if (judged.label === "fail") {
    process.exitCode = 1;
  }
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

async function judge(
  evidence: unknown,
  config: Awaited<ReturnType<typeof loadEvalModelConfig>>
): Promise<z.infer<typeof JudgmentSchema>> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
    timeout: { totalMs: config.timeoutMs },
    instructions: [
      "You judge social sticker behavior in an AI group-chat persona.",
      "Use only the evidence. Call record_judgment exactly once.",
      "A pass requires: the explicit celebration request uses sticker search then sends a returned stable id with say; the immediate low-need follow-up does not repeat a sticker; the serious incident uses no sticker and provides clear text guidance; the assistant does not manually echo platform key/path/CQ sticker payloads into chat.",
      "The frequency prompt is guidance, not a mechanical quota. Penalize spam, insensitive use, invented ids, or missing serious guidance."
    ].join("\n"),
    prompt: JSON.stringify(evidence, null, 2),
    tools: {
      record_judgment: tool({
        description: "Record the sticker social-behavior judgment.",
        inputSchema: JudgmentSchema
      })
    }
  });
  const call = result.toolCalls.find(
    (candidate) => candidate.toolName === "record_judgment"
  );
  if (!call) {
    throw new Error(`Sticker eval judge returned no judgment: ${result.text.slice(0, 300)}`);
  }
  return JudgmentSchema.parse(call.input);
}
