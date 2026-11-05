import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMockConnector,
  createRuntime,
  createScriptedModel,
  createVirtualClock
} from "@gestalt/app";
import { applyConfigOverrides, startLifeSimulation } from "./replayRunner";

// Wakes are serial, so one stuck command would be the end of its life: no wake
// after it, and nothing in the logs. The command has to give up, not the wake.
const start = new Date("2026-11-05T06:00:00.000Z");
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(path.join(os.tmpdir(), "gestalt-bash-timeout-"));
const deadline = setTimeout(() => {
  console.error("bashTimeout.verify: a stuck command stopped the wake");
  process.exit(1);
}, 30_000);

try {
  await cp(path.join(repoRoot, "harness/fixtures/homes/simple-group-test"), root, {
    recursive: true
  });
  await applyConfigOverrides(
    path.join(root, "config.toml"),
    "life_bash_timeout_seconds = 1"
  );
  const clock = createVirtualClock(start);
  const outputs: unknown[] = [];
  const runtime = await createRuntime({
    gestaltHome: root,
    connector: createMockConnector({ now: clock.now }),
    clock,
    agentBrowserTarget: {
      executable: process.execPath,
      argsPrefix: ["-e", "setInterval(() => undefined, 1000)", "--"]
    },
    model: createScriptedModel({
      now: clock.now,
      script({ step, lastOutput }) {
        if (lastOutput !== undefined) {
          outputs.push(lastOutput);
        }
        return [
          { toolName: "look" as const, input: { place: "web" } },
          { toolName: "bash" as const, input: { command: "agent-browser wait" } },
          { toolName: "sleep" as const, input: { seconds: 7200 } }
        ][step];
      }
    })
  });
  const simulation = await startLifeSimulation({
    clock,
    createRuntime: async () => runtime
  });
  await simulation.advanceTo(start.valueOf() + 3_600_000);
  const wakes = [...runtime.loop.wakes];
  await simulation.finish();

  assert.equal(wakes[0]?.status, "completed", "the wake outlives the command");
  assert.match(JSON.stringify(outputs[1]), /"exitCode":124/, "the model hears it timed out");
  console.log("bashTimeout.verify passed");
} finally {
  clearTimeout(deadline);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(0);
