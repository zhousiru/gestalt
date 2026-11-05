import assert from "node:assert/strict";
import { createActionBashToolScope } from "./agentBrowser";

const echoTarget = {
  executable: process.execPath,
  argsPrefix: [
    "-e",
    [
      "const chunks=[];",
      "process.stdin.on('data',(chunk)=>chunks.push(chunk));",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:Buffer.concat(chunks).toString('utf8')})));"
    ].join(""),
    "--"
  ]
};

const skillScope = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-skill-test"
});
const skillResult = await skillScope.exec("agent-browser skills get core");
assert.equal(skillResult.exitCode, 0);
assert.match(skillResult.stdout, /agent-browser core/);
await skillScope.dispose();

const scopedBash = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-loop-test",
  provider: "fortress",
  configPath: "/opt/gestalt/dist/browser/agent-browser.json",
  agentBrowserTarget: echoTarget
});
const piped = await scopedBash.exec(
  "printf 'from-pipe' | agent-browser open 'https://example.test/a b' --json"
);
assert.equal(piped.exitCode, 0);
assert.deepEqual(JSON.parse(piped.stdout).stdin, "from-pipe");

const scopedResult = await scopedBash.exec(
  "agent-browser --namespace rogue --session=rogue --provider rogue --config rogue.json open https://example.test --session ignored --namespace=ignored -pignored"
);
assert.equal(scopedResult.exitCode, 0);
assert.deepEqual(JSON.parse(scopedResult.stdout), {
  argv: [
    "--config",
    "/opt/gestalt/dist/browser/agent-browser.json",
    "--namespace",
    "gestalt",
    "--session",
    "gestalt-loop-test",
    "--provider",
    "fortress",
    "open",
    "https://example.test"
  ],
  stdin: ""
});
const closeResult = await scopedBash.dispose();
assert.deepEqual(JSON.parse(closeResult.stdout), {
  argv: [
    "--config",
    "/opt/gestalt/dist/browser/agent-browser.json",
    "--namespace",
    "gestalt",
    "--session",
    "gestalt-loop-test",
    "--provider",
    "fortress",
    "close"
  ],
  stdin: ""
});
assert.equal(await scopedBash.dispose(), closeResult);

const unusedScopedBash = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-unused-loop",
  agentBrowserTarget: {
    executable: "this-command-must-not-run"
  }
});
assert.deepEqual(await unusedScopedBash.dispose(), {
  stdout: "",
  stderr: "",
  exitCode: 0
});

const browserless = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-dream",
  browser: false,
  agentBrowserTarget: echoTarget
});
const refused = await browserless.exec("agent-browser open https://example.test");
assert.notEqual(refused.exitCode, 0);

const idleScope = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-idle",
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: [
      "-e",
      "process.stdout.write(process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? '')",
      "--"
    ]
  }
});
assert.equal(
  (await idleScope.exec("agent-browser open https://example.test")).stdout,
  "600000",
  "a daemon whose close failed must still leave on its own"
);

const cancellationScope = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-cancel",
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: ["-e", "setInterval(() => undefined, 1000)", "--"]
  }
});
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
const cancellationResult = await cancellationScope.exec(
  "agent-browser wait",
  controller.signal
);
assert.equal(cancellationResult.exitCode, 124);

const inheritedPipeScope = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-pipe",
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: [
      "-e",
      [
        'const {spawn}=require("node:child_process");',
        "const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore','inherit','inherit']});",
        "child.unref();",
        "process.stdout.write('parent-exited');"
      ].join(""),
      "--"
    ]
  }
});
const inheritedPipeStartedAt = Date.now();
const inheritedPipeResult = await inheritedPipeScope.exec("agent-browser test");
const inheritedPipeElapsedMs = Date.now() - inheritedPipeStartedAt;
assert.equal(inheritedPipeResult.exitCode, 0);
assert.match(inheritedPipeResult.stdout, /parent-exited/);
assert.ok(
  inheritedPipeElapsedMs < 1_000,
  `native command waited ${inheritedPipeElapsedMs}ms for an inherited pipe`
);

const firstWake = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-first"
});
const secondWake = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-second"
});
await firstWake.exec("printf 'wake-one' > /state");
assert.match((await firstWake.exec("cat /state")).stdout, /wake-one/);
assert.notEqual((await secondWake.exec("cat /state")).exitCode, 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      coreSkillLoaded: true,
      runtimeOwnedNamespace: "gestalt",
      runtimeOwnedSession: "gestalt-loop-test",
      runtimeOwnedProvider: "fortress",
      sessionClosedOnDispose: true,
      dreamHasNoBrowser: true,
      cancelledExitCode: 124,
      inheritedPipeElapsedMs,
      isolatedVfs: true
    },
    null,
    2
  )
);
