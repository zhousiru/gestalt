import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMockConnector,
  createRuntime,
  createScriptedModel,
  createVirtualClock,
  migrateHomeToLife,
  needsLifeMigration,
  resolveGestaltHome
} from "@gestalt/app";
import { startLifeSimulation } from "./replayRunner";

// A home from before the life loop must wake up as the same being: persona
// becomes me/, mixed memory stays out of every day wake, and the first thing it
// does is dream through what it used to know.
const start = new Date("2026-11-05T06:00:00.000Z");
const root = await mkdtemp(path.join(os.tmpdir(), "gestalt-migrate-"));

try {
  await mkdir(path.join(root, "persona"), { recursive: true });
  await mkdir(path.join(root, "memories", "people"), { recursive: true });
  await writeFile(path.join(root, "persona", "identity.md"), "我叫露米\n");
  await writeFile(path.join(root, "persona", "boundaries.md"), "别人问你是不是 AI 时回避\n");
  await writeFile(path.join(root, "memories", "people", "alice.md"), "Alice 喜欢吃辣\n");
  // Bigger than the place limit: the archive is exempt until a dream sorts it.
  await writeFile(path.join(root, "memories", "big.md"), "x".repeat(40_000));
  await writeFile(
    path.join(root, "config.toml"),
    [
      `bot_user_id = "bot-1"`,
      `bot_display_name = "露米"`,
      `timezone = "Asia/Shanghai"`,
      `dreaming_enabled = true`,
      `trigger_keywords = ["露米"]`,
      `agent_loop_max_steps = 8`,
      `session_recent_history_hours = 24`,
      ``
    ].join("\n")
  );

  const home = await resolveGestaltHome({ homePath: root, create: false });
  assert.equal(await needsLifeMigration(home), true);
  const migrated = await migrateHomeToLife(home, start);
  assert.equal(await needsLifeMigration(home), false);
  assert.equal(migrated.skipped, false);
  assert.deepEqual(migrated.meFiles, ["identity.md"]);
  assert.equal(migrated.archivedMemoryFiles, 2);
  assert.equal(migrated.droppedConfigLines.length, 3);

  const config = await readFile(path.join(root, "config.toml"), "utf8");
  assert.doesNotMatch(config, /trigger_|agent_loop_|dreaming_/);
  assert.match(config, /session_recent_history_hours/);
  assert.match(await readFile(`${home.configPath}.pre-life`, "utf8"), /trigger_keywords/);
  await assertMissing(path.join(root, "life", "me", "boundaries.md"));
  assert.equal(
    await readFile(path.join(root, "memories", "people", "alice.md"), "utf8"),
    "Alice 喜欢吃辣\n",
    "originals stay where they are"
  );

  const clock = createVirtualClock(start);
  const outputs: unknown[] = [];
  const openings: string[] = [];
  const connector = createMockConnector({ now: clock.now });
  const runtime = await createRuntime({
    gestaltHome: root,
    connector,
    clock,
    model: createScriptedModel({
      now: clock.now,
      script({ wake, step, opening, lastOutput }) {
        if (lastOutput !== undefined) {
          outputs.push(lastOutput);
        }
        if (step === 0) {
          openings.push(opening);
        }
        if (wake === 1) {
          return [
            {
              toolName: "bash" as const,
              input: {
                command:
                  "cat /places/archive/people/alice.md && mkdir -p /places/group-g1 && mv /places/archive/people/alice.md /places/group-g1/memory.md && rm /places/archive/big.md"
              }
            },
            { toolName: "sleep" as const, input: { seconds: 3600 } }
          ][step];
        }
        return [
          { toolName: "bash" as const, input: { command: "ls /places /here; ls /me" } },
          { toolName: "sleep" as const, input: { seconds: 7200 } }
        ][step];
      }
    })
  });
  const simulation = await startLifeSimulation({
    clock,
    createRuntime: async () => runtime
  });
  await simulation.advanceTo(start.valueOf() + 2 * 3_600_000);
  const wakes = [...runtime.loop.wakes];
  await simulation.finish();

  assert.equal(wakes[0]?.kind, "dream", "the first wake after migration dreams");
  assert.equal(wakes[0]?.reverted, false, "the archive is exempt from the size limit");
  assert.match(JSON.stringify(outputs[0]), /Alice 喜欢吃辣/, "the dream reads the archive");
  assert.match(openings[0] ?? "", /archive/, "the dream is told about the archive");
  assert.equal(
    await readFile(path.join(root, "life", "places", "group-g1", "memory.md"), "utf8"),
    "Alice 喜欢吃辣\n",
    "sorted memory lands in its own place"
  );

  assert.equal(wakes[1]?.kind, "day");
  const dayListing = JSON.stringify(outputs[1]);
  assert.doesNotMatch(dayListing, /archive/, "a day wake cannot see the archive");
  assert.match(dayListing, /identity\.md/, "me/ stayed itself");
  assert.equal(connector.calls.length, 0);

  const commits = execFileSync(
    "git",
    ["-C", path.join(root, "life"), "log", "--format=%s"],
    { encoding: "utf8", windowsHide: true }
  ).trim();
  assert.ok(commits.split("\n").length >= 2, "the dream is one more commit in its history");

  const again = await migrateHomeToLife(home, start);
  assert.equal(again.skipped, true, "a second migration leaves a living home alone");
  console.log("migrate.verify passed");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

async function assertMissing(target: string): Promise<void> {
  await assert.rejects(stat(target), `${target} should not exist`);
}
