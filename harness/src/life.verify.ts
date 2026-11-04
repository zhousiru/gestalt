import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertReplayRun } from "./assertions";
import { getHarnessPaths, runScenarioFixture } from "./replayRunner";

// Scripted fixtures prove the body: when it wakes, what it can reach, what
// survives. Real-model scenarios are selected with `life-model-` and `life-soul-`.
const { repoRoot } = getHarnessPaths();
const directory = path.join(repoRoot, "harness", "fixtures", "scenarios");
const filter = process.argv[2];
const fixtures = (await readdir(directory))
  .filter((name) => name.startsWith("life-") && name.endsWith(".json"))
  .filter((name) => !name.startsWith("life-model-") && !name.startsWith("life-soul-"))
  .filter((name) => !filter || name.includes(filter))
  .sort();

let failures = 0;
for (const name of fixtures) {
  try {
    const result = await runScenarioFixture(
      path.join("harness", "fixtures", "scenarios", name)
    );
    assertReplayRun(result);
    console.log(
      `ok ${result.fixture.id}: ${result.wakes.length} wakes, ${result.lifeLog.length} commits`
    );
  } catch (error) {
    failures += 1;
    console.error(`FAILED ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}
console.log(`${fixtures.length - failures}/${fixtures.length} fixtures passed`);
if (failures > 0) {
  process.exitCode = 1;
}
