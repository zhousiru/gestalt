import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadDotenvFile } from "dotenv";
import {
  createAiSdkModelFromConfig,
  createMockConnector,
  createRuntime,
  createScriptedModel,
  createVirtualClock,
  loadConfig,
  resolveGestaltHome,
  SessionJournalRecordSchema,
  type MockConnector,
  type ModelClient,
  type ModelRequestSnapshot,
  type ReconstructedInput,
  type RolloutDetail,
  type Runtime,
  type SessionDiagnostics,
  type SessionJournalRecord,
  type VirtualClock,
  type WakeResult
} from "@gestalt/app";
import { ScenarioFixtureSchema, type ScenarioFixture } from "./fixtureSchema";
import {
  createModelExchangeCapture,
  type ModelExchangeSnapshot
} from "./modelExchangeCapture";
import { writeArtifactJson } from "./artifactBinary";
import { readAndValidateRolloutCapture } from "./rolloutCaptureValidation";

export type { ModelExchangeSnapshot } from "./modelExchangeCapture";

export interface ReplayRunResult {
  fixture: ScenarioFixture;
  session: SessionDiagnostics;
  sessionJournal: SessionJournalRecord[];
  wakes: WakeResult[];
  lifeLog: string[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
  modelRequests: ModelRequestSnapshot[];
  modelExchanges: ModelExchangeSnapshot[];
  homeBefore: HomeSnapshot;
  homeAfter: HomeSnapshot;
  connector: MockConnector;
  artifactDir: string;
  artifactPaths: Record<string, string>;
}

export interface HomeSnapshot {
  capturedAt: string;
  files: HomeFileSnapshot[];
}

export interface HomeFileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  content?: string;
}

export interface LifeSimulation {
  clock: VirtualClock;
  runtime(): Runtime;
  advanceTo(at: Date | number): Promise<void>;
  restart(): Promise<void>;
  finish(): Promise<void>;
}

/**
 * Drives a runtime on a virtual clock: time only moves when nothing is
 * running, so a model call of any real duration takes no simulated time.
 */
export async function startLifeSimulation(input: {
  clock: VirtualClock;
  createRuntime: () => Promise<Runtime>;
}): Promise<LifeSimulation> {
  const { clock } = input;
  let runtime = await input.createRuntime();
  runtime.startLife();

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.loop.whenQuiescent();
  };

  const advanceTo = async (at: Date | number): Promise<void> => {
    const target = new Date(at).valueOf();
    while (true) {
      await settle();
      const due = clock.nextDueAt();
      if (due === undefined || due > target) {
        break;
      }
      clock.advanceTo(due);
    }
    clock.advanceTo(target);
    await settle();
  };

  return {
    clock,
    runtime: () => runtime,
    advanceTo,
    async restart() {
      await settle();
      await runtime.shutdown();
      runtime = await input.createRuntime();
      runtime.startLife();
      await settle();
    },
    async finish() {
      await settle();
      await runtime.shutdown();
    }
  };
}

export async function runScenarioFixture(
  fixturePath: string
): Promise<ReplayRunResult> {
  const paths = getReplayPaths(fixturePath);
  loadLocalEnv(paths.repoRoot);
  const fixture = ScenarioFixtureSchema.parse(
    JSON.parse(await readFile(paths.fixturePath, "utf8"))
  );
  return runScenario(fixture, paths);
}

export async function runScenario(
  fixture: ScenarioFixture,
  paths: { repoRoot: string; artifactRoot: string }
): Promise<ReplayRunResult> {
  const tempHome = await createScenarioHome(paths.repoRoot, fixture);

  try {
    const clock = createVirtualClock(fixture.start);
    const now = clock.now;
    const home = await resolveGestaltHome({ homePath: tempHome, create: false });
    const config = await loadConfig(home);
    const connector = createMockConnector({ now });
    const modelCapture = createModelExchangeCapture();
    const baseModel: ModelClient =
      fixture.model.kind === "configured_ai_sdk"
        ? createAiSdkModelFromConfig(config, { now })
        : createFixtureScriptedModel(fixture, now);
    const model = modelCapture.wrap(baseModel);
    const homeBefore = await snapshotHome(tempHome);
    const wakes: WakeResult[] = [];
    let current: Runtime | undefined;
    const captureWakes = (): void => {
      if (current) {
        wakes.push(...current.loop.wakes);
      }
    };

    const simulation = await startLifeSimulation({
      clock,
      async createRuntime() {
        captureWakes();
        current = await createRuntime({
          gestaltHome: tempHome,
          connector,
          model,
          clock
        });
        return current;
      }
    });

    const startMs = new Date(fixture.start).valueOf();
    const timeline = [
      ...fixture.events.map((event) => ({ at: event.at, event })),
      ...fixture.restarts.map((at) => ({ at, event: undefined }))
    ].sort((left, right) => left.at - right.at);

    for (const entry of timeline) {
      await simulation.advanceTo(startMs + entry.at * 1000);
      if (!entry.event) {
        await simulation.restart();
        continue;
      }
      const eventInput = entry.event;
      const event = connector.createMessageEvent({
        conversationKind: eventInput.conversationKind,
        conversationId: eventInput.conversationId,
        ...(eventInput.conversationName
          ? { conversationName: eventInput.conversationName }
          : {}),
        senderId: eventInput.senderId,
        ...(eventInput.senderName ? { senderName: eventInput.senderName } : {}),
        ...(eventInput.messageId ? { messageId: eventInput.messageId } : {}),
        text: eventInput.text,
        ...(eventInput.replyToMessageId
          ? { replyToMessageId: eventInput.replyToMessageId }
          : {}),
        mentionsBot: eventInput.mentionsBot
      });
      if (eventInput.messageId) {
        event.id = eventInput.messageId;
      }
      await simulation.runtime().dispatchEvent(event);
    }
    const lastAt = timeline.at(-1)?.at ?? 0;
    await simulation.advanceTo(startMs + (lastAt + fixture.until) * 1000);
    const finalRuntime = simulation.runtime();
    await simulation.finish();
    captureWakes();

    const session = finalRuntime.exportDiagnostics({
      exportedAt: clock.now().toISOString()
    });
    const sessionJournal = await readSessionJournal(home.sessionsDir);
    const modelExchanges = modelCapture.exchanges;
    const modelRequests = modelExchanges.map((exchange) => exchange.request);
    // Validation below compares rollouts, so it would hide why a wake failed.
    for (const wake of wakes.filter((candidate) => candidate.status === "failed")) {
      console.error(`${fixture.id}: wake at ${wake.startedAt} failed: ${wake.error}`);
    }
    const { rollouts, reconstructedInputs } =
      await readAndValidateRolloutCapture(
        home.tracesDir,
        modelExchanges,
        wakes.map((wake) => wake.rolloutId)
      );
    const homeAfter = await snapshotHome(tempHome);
    const lifeLog = readLifeLog(path.join(tempHome, "life"));
    const artifactDir = path.join(paths.artifactRoot, fixture.id);
    const artifactPaths = await writeArtifacts({
      artifactDir,
      fixture,
      session,
      sessionJournal,
      wakes,
      lifeLog,
      rollouts,
      reconstructedInputs,
      modelRequests,
      modelExchanges,
      homeBefore,
      homeAfter,
      connector
    });

    return {
      fixture,
      session,
      sessionJournal,
      wakes,
      lifeLog,
      rollouts,
      reconstructedInputs,
      modelRequests,
      modelExchanges,
      homeBefore,
      homeAfter,
      connector,
      artifactDir,
      artifactPaths
    };
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

function createFixtureScriptedModel(
  fixture: ScenarioFixture,
  now: () => Date
): ModelClient {
  if (fixture.model.kind !== "scripted") {
    throw new Error("Fixture does not use a scripted model.");
  }
  const { wakes, usagePerStep } = fixture.model;
  return createScriptedModel({
    now,
    ...(usagePerStep ? { usagePerStep } : {}),
    script({ wake, step }) {
      const steps = wakes[wake - 1];
      if (!steps) {
        return step === 0
          ? { toolName: "sleep", input: { seconds: 3600 } }
          : undefined;
      }
      const next = steps[step];
      return next ? { toolName: next.tool, input: next.input } : undefined;
    }
  });
}

/** TOML refuses a repeated key, so an override takes the old line's place. */
export async function applyConfigOverrides(
  configPath: string,
  overrides: string
): Promise<void> {
  const keyOf = (line: string): string | undefined =>
    line.match(/^\s*([A-Za-z0-9_]+)\s*=/)?.[1];
  const overridden = new Set(overrides.split("\n").map(keyOf));
  const kept = (await readFile(configPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => !overridden.has(keyOf(line) ?? ""));
  await writeFile(configPath, `${kept.join("\n")}\n${overrides}\n`, "utf8");
}

function readLifeLog(lifeDir: string): string[] {
  try {
    return execFileSync("git", ["-C", lifeDir, "log", "--format=%s"], {
      encoding: "utf8",
      windowsHide: true
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getReplayPaths(fixturePath: string): {
  repoRoot: string;
  fixturePath: string;
  artifactRoot: string;
} {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  return {
    repoRoot,
    fixturePath: path.resolve(repoRoot, fixturePath),
    artifactRoot: path.join(repoRoot, "harness", "artifacts")
  };
}

export function getHarnessPaths(): {
  repoRoot: string;
  artifactRoot: string;
} {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  return { repoRoot, artifactRoot: path.join(repoRoot, "harness", "artifacts") };
}

async function createScenarioHome(
  repoRoot: string,
  fixture: ScenarioFixture
): Promise<string> {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-replay-"));
  await cp(
    path.join(
      repoRoot,
      fixture.homeFixture ?? "harness/fixtures/homes/simple-group-test"
    ),
    tempHome,
    { recursive: true }
  );
  if (fixture.configOverrides) {
    await applyConfigOverrides(
      path.join(tempHome, "config.toml"),
      fixture.configOverrides
    );
  }
  if (fixture.lifeFixture) {
    await cp(
      path.join(repoRoot, fixture.lifeFixture),
      path.join(tempHome, "life"),
      { recursive: true }
    );
  }
  return tempHome;
}

async function readSessionJournal(
  sessionsDir: string
): Promise<SessionJournalRecord[]> {
  const journalDir = path.join(sessionsDir, "journal");
  const files = await collectJsonlFiles(journalDir);
  const records: SessionJournalRecord[] = [];
  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim()) {
        records.push(SessionJournalRecordSchema.parse(JSON.parse(line)));
      }
    }
  }
  return records;
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

async function snapshotHome(homeRoot: string): Promise<HomeSnapshot> {
  const files = await collectHomeFiles(homeRoot, homeRoot);
  return {
    capturedAt: new Date().toISOString(),
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
}

async function collectHomeFiles(
  root: string,
  directory: string
): Promise<HomeFileSnapshot[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: HomeFileSnapshot[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    if (isSecretPath(relativePath) || entry.name === ".git") {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectHomeFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const content = await readFile(absolutePath);
    const fileStat = await stat(absolutePath);
    const snapshot: HomeFileSnapshot = {
      path: relativePath,
      bytes: fileStat.size,
      sha256: createHash("sha256").update(content).digest("hex")
    };
    if (
      content.length <= 64 * 1024 &&
      [".json", ".jsonl", ".md", ".txt", ".toml"].includes(
        path.extname(relativePath).toLowerCase()
      )
    ) {
      snapshot.content = content.toString("utf8");
    }
    files.push(snapshot);
  }
  return files;
}

async function writeArtifacts(input: {
  artifactDir: string;
  fixture: ScenarioFixture;
  session: SessionDiagnostics;
  sessionJournal: SessionJournalRecord[];
  wakes: WakeResult[];
  lifeLog: string[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
  modelRequests: ModelRequestSnapshot[];
  modelExchanges: ModelExchangeSnapshot[];
  homeBefore: HomeSnapshot;
  homeAfter: HomeSnapshot;
  connector: MockConnector;
}): Promise<Record<string, string>> {
  await rm(input.artifactDir, { recursive: true, force: true });
  await mkdir(input.artifactDir, { recursive: true });
  const file = (name: string): string => path.join(input.artifactDir, name);
  const artifactPaths = {
    session: file("session.json"),
    sessionJournal: file("session-journal.json"),
    wakes: file("wakes.json"),
    rollouts: file("rollouts.json"),
    reconstructedInputs: file("reconstructed-inputs.json"),
    modelRequests: file("model-requests.json"),
    modelExchanges: file("model-exchanges.json"),
    connector: file("connector-calls.json"),
    homeBefore: file("home-before.json"),
    homeAfter: file("home-after.json"),
    summary: file("summary.json"),
    report: file("report.md")
  };
  const summary = {
    id: input.fixture.id,
    description: input.fixture.description,
    modelKind: input.fixture.model.kind,
    wakes: input.wakes.map((wake) => ({
      reason: wake.reason,
      kind: wake.kind,
      place: wake.place,
      status: wake.status,
      startedAt: wake.startedAt,
      said: wake.said,
      held: wake.held,
      requestedSleepSeconds: wake.requestedSleepSeconds,
      tokens: wake.usage.inputTokens + wake.usage.outputTokens,
      note: wake.note
    })),
    lifeLog: input.lifeLog,
    rollouts: input.rollouts.length,
    modelExchanges: input.modelExchanges.length,
    totalTokens: input.wakes.reduce(
      (total, wake) => total + wake.usage.inputTokens + wake.usage.outputTokens,
      0
    ),
    cacheReadTokens: input.wakes.reduce(
      (total, wake) => total + wake.usage.cachedTokens,
      0
    ),
    connectorCalls: input.connector.calls.map((call) => ({
      kind: call.kind,
      input: call.input
    }))
  };
  await Promise.all([
    writeArtifactJson(artifactPaths.session, input.session),
    writeArtifactJson(artifactPaths.sessionJournal, input.sessionJournal),
    writeArtifactJson(artifactPaths.wakes, input.wakes),
    writeArtifactJson(artifactPaths.rollouts, input.rollouts),
    writeArtifactJson(artifactPaths.reconstructedInputs, input.reconstructedInputs),
    writeArtifactJson(artifactPaths.modelRequests, input.modelRequests),
    writeArtifactJson(artifactPaths.modelExchanges, input.modelExchanges),
    writeArtifactJson(artifactPaths.connector, input.connector.calls),
    writeArtifactJson(artifactPaths.homeBefore, input.homeBefore),
    writeArtifactJson(artifactPaths.homeAfter, input.homeAfter),
    writeArtifactJson(artifactPaths.summary, summary),
    writeFile(artifactPaths.report, renderReport(input, summary), "utf8")
  ]);
  return artifactPaths;
}

function renderReport(
  input: {
    fixture: ScenarioFixture;
    wakes: WakeResult[];
    lifeLog: string[];
    connector: MockConnector;
  },
  summary: { totalTokens: number }
): string {
  return [
    `# Replay Report: ${input.fixture.id}`,
    "",
    input.fixture.description,
    "",
    "## Life",
    "",
    `- Wakes: ${input.wakes.length}`,
    `- Tokens: ${summary.totalTokens}`,
    `- Commits: ${input.lifeLog.length}`,
    "",
    "## Wakes",
    "",
    ...input.wakes.map(
      (wake) =>
        `- ${wake.startedAt} ${wake.reason} -> ${wake.place ?? "phone"}: said ${wake.said}, held ${wake.held}, slept ${wake.requestedSleepSeconds ?? "default"}${wake.note ? `, note: ${wake.note}` : ""}`
    ),
    "",
    "## Said",
    "",
    ...input.connector.calls.map(
      (call) => `- ${call.kind}: ${JSON.stringify(call.input)}`
    ),
    ""
  ].join("\n");
}

function isSecretPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("secret")
  );
}

function loadLocalEnv(repoRoot: string): void {
  for (const fileName of [".env", ".env.local"]) {
    loadDotenvFile({
      path: path.join(repoRoot, fileName),
      override: false,
      quiet: true
    });
  }
}
