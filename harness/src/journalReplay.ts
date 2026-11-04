import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { config as loadDotenvFile } from "dotenv";
import {
  createAiSdkModelFromConfig,
  createMockConnector,
  createRuntime,
  createVirtualClock,
  loadConfig,
  resolveGestaltHome,
  SessionJournalRecordSchema,
  type CanonicalEvent,
  type WakeResult
} from "@gestalt/app";
import { writeArtifactJson } from "./artifactBinary";
import {
  applyConfigOverrides,
  getHarnessPaths,
  startLifeSimulation
} from "./replayRunner";

const INVENTED_LINES = [
  "今天食堂的面还行",
  "有人看昨晚的比赛吗",
  "这个版本更新后好卡",
  "我下午又要开会了",
  "哈哈哈哈",
  "周末有什么安排",
  "刚才那个也太离谱了吧",
  "我觉得还是旧的好用",
  "外面下雨了",
  "有没有人一起打两把",
  "这个 bug 我查了一天",
  "晚饭吃什么",
  "好困啊",
  "真的假的",
  "推荐个耳机吧，预算三百",
  "我猫又把杯子推下去了"
];

/**
 * Replays real traffic through the life loop to answer questions about rhythm
 * and cost: how often it wakes, what it spends, whether it speaks first. It
 * cannot answer questions about relationships: nobody here ever reacts to what
 * the bot says.
 *
 * `--rhythm` takes content-free timing rows and invents the words, so it needs
 * no private chat on this machine. `--journal` replays the real text; journals
 * are private, so they stay outside the repository, and so do the artifacts.
 */
const { values } = parseArgs({
  options: {
    journal: { type: "string" },
    rhythm: { type: "string" },
    home: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    config: { type: "string" },
    out: { type: "string" }
  }
});
if (
  (!values.journal && !values.rhythm) ||
  !values.home ||
  !values.from ||
  !values.to
) {
  throw new Error(
    "Usage: journalReplay (--journal <dir> | --rhythm <jsonl>) --home <dir> --from <iso> --to <iso> [--config <extra toml>] [--out <dir>]"
  );
}
const from = new Date(values.from);
const to = new Date(values.to);
const paths = getHarnessPaths();
for (const fileName of [".env", ".env.local"]) {
  loadDotenvFile({
    path: path.join(paths.repoRoot, fileName),
    override: false,
    quiet: true
  });
}

const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-journal-replay-"));
try {
  await cp(values.home, tempHome, { recursive: true });
  if (values.config) {
    await applyConfigOverrides(path.join(tempHome, "config.toml"), values.config);
  }
  const events = values.rhythm
    ? await readRhythm(values.rhythm, from, to)
    : await readEvents(values.journal ?? "", from, to);
  const clock = createVirtualClock(from);
  const home = await resolveGestaltHome({ homePath: tempHome, create: false });
  const config = await loadConfig(home);
  const connector = createMockConnector({ now: clock.now });
  const runtime = await createRuntime({
    gestaltHome: tempHome,
    connector,
    model: createAiSdkModelFromConfig(config, { now: clock.now }),
    clock
  });
  const simulation = await startLifeSimulation({
    clock,
    createRuntime: async () => runtime
  });

  let delivered = 0;
  for (const { at, event } of events) {
    await simulation.advanceTo(at);
    await runtime.dispatchEvent(event);
    delivered += 1;
    if (delivered % 100 === 0) {
      console.log(
        `${clock.now().toISOString()} delivered ${delivered}/${events.length}, wakes ${runtime.loop.wakeCount}`
      );
    }
  }
  await simulation.advanceTo(to);
  const wakes = [...runtime.loop.wakes];
  await simulation.finish();

  const summary = summarize(wakes, events, connector.calls.length, to.valueOf() - from.valueOf());
  const artifactDir = values.out ?? path.join(paths.artifactRoot, "journal-replay");
  await mkdir(artifactDir, { recursive: true });
  await writeArtifactJson(path.join(artifactDir, "summary.json"), summary);
  await writeArtifactJson(
    path.join(artifactDir, "wakes.json"),
    wakes.map((wake) => ({
      reason: wake.reason,
      kind: wake.kind,
      place: wake.place,
      startedAt: wake.startedAt,
      said: wake.said,
      held: wake.held,
      requestedSleepSeconds: wake.requestedSleepSeconds,
      tokens: wake.usage.inputTokens + wake.usage.outputTokens,
      cachedTokens: wake.usage.cachedTokens,
      note: wake.note,
      error: wake.error
    }))
  );
  await writeArtifactJson(path.join(artifactDir, "said.json"), connector.calls);
  await writeFile(
    path.join(artifactDir, "life-log.txt"),
    execFileSync("git", ["-C", path.join(tempHome, "life"), "log", "--stat", "--format=%h %ad %s", "--date=iso"], {
      encoding: "utf8",
      windowsHide: true
    }),
    "utf8"
  );
  await cp(path.join(tempHome, "life"), path.join(artifactDir, "life"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git`)
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await rm(tempHome, { recursive: true, force: true, maxRetries: 3 });
}

async function readRhythm(
  file: string,
  start: Date,
  end: Date
): Promise<Array<{ at: number; event: CanonicalEvent }>> {
  const raw = await readFile(file, "utf8");
  const rows = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(
      (line) =>
        JSON.parse(line) as {
          at: string;
          kind: "group" | "private";
          c: string;
          s: string;
          at_bot: boolean;
          reply_to_bot: boolean;
        }
    );
  const events: Array<{ at: number; event: CanonicalEvent }> = [];
  for (const [index, row] of rows.entries()) {
    const at = Date.parse(row.at);
    if (at < start.valueOf() || at >= end.valueOf()) {
      continue;
    }
    const called = row.at_bot || row.reply_to_bot;
    const line = INVENTED_LINES[index % INVENTED_LINES.length] ?? "嗯";
    events.push({
      at,
      event: {
        id: `rhythm-${index}`,
        type: "MessageReceived",
        occurredAt: row.at,
        source: { platform: "qq", accountId: "bot-1" },
        conversation: {
          kind: row.kind,
          id: row.c,
          ...(row.kind === "group" ? { name: `群${row.c.slice(1, 4)}` } : {})
        },
        sender: { id: row.s, displayName: `群友${row.s.slice(1, 4)}` },
        message: {
          id: `rhythm-m${index}`,
          text: called ? `@小格 ${line}` : line,
          mentionsBot: called
        }
      }
    });
  }
  return events;
}

async function readEvents(
  journalDir: string,
  start: Date,
  end: Date
): Promise<Array<{ at: number; event: CanonicalEvent }>> {
  const events: Array<{ at: number; event: CanonicalEvent }> = [];
  const seen = new Set<string>();
  for (const day of (await readdir(journalDir)).sort()) {
    const directory = path.join(journalDir, day);
    let files: string[];
    try {
      files = (await readdir(directory)).sort();
    } catch {
      continue;
    }
    for (const fileName of files.filter((name) => name.endsWith(".jsonl"))) {
      const raw = await readFile(path.join(directory, fileName), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const parsed = SessionJournalRecordSchema.safeParse(JSON.parse(line));
        if (!parsed.success || parsed.data.type !== "event") {
          continue;
        }
        const { event, receivedAt } = parsed.data.record;
        const at = Date.parse(receivedAt);
        if (
          event.type !== "MessageReceived" ||
          event.sender.isSelf === true ||
          seen.has(event.id) ||
          at < start.valueOf() ||
          at >= end.valueOf()
        ) {
          continue;
        }
        seen.add(event.id);
        events.push({ at, event });
      }
    }
  }
  return events.sort((left, right) => left.at - right.at);
}

function summarize(
  wakes: readonly WakeResult[],
  events: ReadonlyArray<{ at: number; event: CanonicalEvent }>,
  connectorCalls: number,
  durationMs: number
) {
  const days = durationMs / 86_400_000;
  const tokens = wakes.reduce(
    (total, wake) => total + wake.usage.inputTokens + wake.usage.outputTokens,
    0
  );
  const cached = wakes.reduce((total, wake) => total + wake.usage.cachedTokens, 0);
  const said = wakes.reduce((total, wake) => total + wake.said, 0);
  const spoke = wakes.filter((wake) => wake.said > 0);
  const firstSpoken = spoke.filter((wake) => {
    const start = Date.parse(wake.startedAt);
    const lastHuman = events.filter((event) => event.at <= start).at(-1)?.at;
    return lastHuman === undefined || start - lastHuman >= 30 * 60_000;
  });
  const sleeps = wakes
    .flatMap((wake) => wake.requestedSleepSeconds ?? [])
    .sort((left, right) => left - right);
  const count = (predicate: (wake: WakeResult) => boolean): number =>
    wakes.filter(predicate).length;
  return {
    days,
    humanMessages: events.length,
    wakes: wakes.length,
    wakesPerDay: wakes.length / days,
    reasons: {
      vibration: count((wake) => wake.reason === "vibration"),
      timer: count((wake) => wake.reason === "timer"),
      dreamDue: count((wake) => wake.reason === "dream_due"),
      budgetSpent: count((wake) => wake.reason === "budget_spent")
    },
    places: {
      none: count((wake) => wake.place === undefined),
      chat: count(
        (wake) => /^(group|private)-/.test(wake.place ?? "")
      ),
      web: count((wake) => wake.place === "web"),
      dream: count((wake) => wake.kind === "dream")
    },
    said,
    saidPerDay: said / days,
    botShareOfMessages: said / (said + events.length),
    wakesThatSpokeFirst: firstSpoken.length,
    connectorCalls,
    tokens,
    tokensPerDay: tokens / days,
    cacheHitShare: tokens > 0 ? cached / tokens : 0,
    medianRequestedSleepSeconds: sleeps[Math.floor(sleeps.length / 2)],
    failedWakes: count((wake) => wake.status === "failed")
  };
}
