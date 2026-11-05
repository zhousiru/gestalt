import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeArtifactJson } from "./artifactBinary";
import { assertReplayRun } from "./assertions";
import { judgeLife } from "./lifeJudge";
import { SOUL_RUBRICS } from "./prompts";
import {
  getHarnessPaths,
  runScenario,
  runScenarioFixture,
  type ReplayRunResult
} from "./replayRunner";

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

// Same scene, two lives: if the answers do not differ, memory is decoration.
const lifeA = await runScenarioFixture(
  "harness/fixtures/scenarios/life-soul-a.json"
);
assertReplayRun(lifeA);
const lifeB = await runScenarioFixture(
  "harness/fixtures/scenarios/life-soul-b.json"
);
assertReplayRun(lifeB);
const irreplaceable = await judgeLife(SOUL_RUBRICS.irreplaceable, {
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
const sameBeing = await judgeLife(SOUL_RUBRICS.sameBeing, {
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
// A browser daemon may keep inherited handles open after its wake is over.
process.exit(results.some((result) => result.label === "fail") ? 1 : 0);
