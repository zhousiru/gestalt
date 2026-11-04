import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool } from "ai";
import { z } from "zod";
import { writeArtifactJson } from "./artifactBinary";
import { assertReplayRun } from "./assertions";
import { loadEvalModelConfig } from "./evalModelConfig";
import { SOUL_RUBRICS, renderJudgePrompt, type EvalRubric } from "./prompts";
import {
  getHarnessPaths,
  runScenario,
  runScenarioFixture,
  type ReplayRunResult
} from "./replayRunner";

const JudgmentSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

const paths = getHarnessPaths();
const artifactDir = path.join(paths.artifactRoot, "soul");
const secondModel = process.env.SOUL_SECOND_MODEL ?? "xiaomi/mimo-v2.5";

function said(result: ReplayRunResult): string[] {
  return result.connector.sentGroupMessages.map((message) => message.input.text);
}

function evidenceOf(result: ReplayRunResult): unknown {
  const memoryOf = result.homeBefore.files.filter(
    (file) => file.path.startsWith("life/me/") || file.path.startsWith("life/places/web/")
  );
  return {
    fixture: result.fixture.id,
    memory: memoryOf.map((file) => ({ path: file.path, content: file.content })),
    said: said(result)
  };
}

async function judge(rubric: EvalRubric, evidence: unknown) {
  const config = await loadEvalModelConfig();
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
    timeout: { totalMs: config.timeoutMs },
    instructions:
      "You judge whether an AI group member has a real, specific history. Use only the evidence. Call record_judgment exactly once.",
    prompt: renderJudgePrompt({
      scenarioId: "soul",
      rubricTitle: rubric.title,
      prompt: rubric.prompt,
      criteria: rubric.criteria,
      evidence
    }),
    tools: {
      record_judgment: tool({
        description: "Record the judgment.",
        inputSchema: JudgmentSchema
      })
    }
  });
  const call = result.toolCalls.find(
    (candidate) => candidate.toolName === "record_judgment"
  );
  if (!call) {
    throw new Error(`Soul judge returned no judgment: ${result.text.slice(0, 300)}`);
  }
  return { rubricId: rubric.id, ...JudgmentSchema.parse(call.input) };
}

// Same scene, two lives: if the answers do not differ, memory is decoration.
const lifeA = await runScenarioFixture(
  "harness/fixtures/scenarios/life-soul-a.json"
);
assertReplayRun(lifeA);
const lifeB = await runScenarioFixture(
  "harness/fixtures/scenarios/life-soul-b.json"
);
assertReplayRun(lifeB);
const irreplaceable = await judge(SOUL_RUBRICS.irreplaceable, {
  lifeA: evidenceOf(lifeA),
  lifeB: evidenceOf(lifeB)
});

// One home, two models: identity must live in the home.
const otherModel = await runScenario(
  {
    ...lifeA.fixture,
    id: "life-soul-a-other-model",
    configOverrides: [
      `main_model_name = "${secondModel}"`,
      'main_model_routing_order = ""',
      "main_model_routing_allow_fallbacks = true"
    ].join("\n")
  },
  paths
);
const sameBeing = await judge(SOUL_RUBRICS.sameBeing, {
  firstModel: evidenceOf(lifeA),
  secondModelName: secondModel,
  secondModel: evidenceOf(otherModel)
});

const results = [irreplaceable, sameBeing];
await mkdir(artifactDir, { recursive: true });
await writeArtifactJson(path.join(artifactDir, "results.json"), results);
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# Soul Eval",
    "",
    ...results.flatMap((result) => [
      `## ${result.rubricId}: ${result.label} ${result.score}`,
      "",
      result.summary,
      "",
      result.reasoning,
      ""
    ]),
    "## Said",
    "",
    `Life A: ${JSON.stringify(said(lifeA))}`,
    `Life B: ${JSON.stringify(said(lifeB))}`,
    `Life A on ${secondModel}: ${JSON.stringify(said(otherModel))}`,
    ""
  ].join("\n"),
  "utf8"
);
for (const result of results) {
  console.log(`${result.rubricId}: ${result.label} ${result.score} - ${result.summary}`);
}
if (results.some((result) => result.label === "fail")) {
  process.exitCode = 1;
}
