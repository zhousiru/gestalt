# Harness Workflow

## Document Status

This document records the current development workflow for the replay harness.

It is intentionally practical. `MASTERDOC.md` defines why the harness exists; this file defines how to use and extend it during ordinary development.

## Purpose

The harness turns runtime behavior into replayable evidence. Every meaningful runtime behavior should be represented by a scenario fixture that can be replayed, inspected, and asserted without a live connector.

It should answer:

- What messages arrived, and when?
- Which home, life, and config were used?
- When did it wake, why, and where did it go?
- What did the model see, and what did it do?
- What changed in its home?
- Did the behavior match expectations?

## Current Shape

```text
harness/
  config/eval.toml        judge model; never inherits from a GestaltHome
  fixtures/
    homes/                base GestaltHomes
    lives/                pre-lived life/ directories
    scenarios/            scenario JSON
  src/
    fixtureSchema.ts      scenario schema
    replayRunner.ts       virtual-clock simulation and artifact export
    assertions.ts         checks against exported evidence
    life.verify.ts        all scripted life-* fixtures
    migrate.verify.ts     an older home waking up as the same being
    journalReplay.ts      real traffic through the loop, for rhythm and cost
    eval.ts, evalRunner.ts, prompts/eval.ts, soul.eval.ts
    onebotProtocol.verify.ts, onebotProtocol.eval.ts, stickersSocial.eval.ts
    ...
  artifacts/<scenario>/   generated evidence, ignored by git
```

## Scenario Fixture Format

| Field | Meaning |
| --- | --- |
| `id`, `description` | Stable id and human purpose. |
| `start` | ISO time the virtual clock starts at. |
| `until` | Seconds to keep living after the last event. |
| `homeFixture` | Base GestaltHome; defaults to `simple-group-test`. |
| `configOverrides` | TOML lines appended to the home's config. |
| `lifeFixture` | A `life/` copied in before first boot, for a life with history. |
| `restarts` | Offsets at which the whole runtime restarts. |
| `model` | `{ "kind": "scripted", "wakes": [...] }` or `{ "kind": "configured_ai_sdk" }`. |
| `events` | Messages, each with `at` in seconds from `start`. |
| `expectations` | `wakes`, `connector`, `modelInput`, `toolOutputs`, `life`, `rollout`, `session`. |

Scripted `wakes` hold one list of steps per wake. Later wakes go back to sleep. A `null` step is the model stopping without calling anything.

Scripted models prove the body: when it wakes, what it can reach, what survives. They must not be the only proof of anything that depends on the model's judgment. Real-model scenarios are named `life-model-*` and `life-soul-*` and run through `eval:*`.

## Model Routing

Configured model scenarios read model settings from the fixture home `config.toml`; see [CONFIGURATION.md](CONFIGURATION.md) and [MODEL_CONFIGURATION.md](MODEL_CONFIGURATION.md). Provider-specific options stay in config, not in harness scripts.

Some providers reject forced tool choice, and OpenRouter has no DeepSeek endpoint for it. The fixtures use `main_model_tool_choice = "auto"`. If every wake in a run fails, read `error` in `wakes.json` before reading anything else; the judge will describe a wake that failed as a bot that went back to sleep.

### Eval Judge Configuration

The LLM judge is harness infrastructure, not part of the runtime. It reads `harness/config/eval.toml` and never inherits model settings from a home. The API key stays in its named environment variable.

Override the judge config with either:

```text
--eval-config path/to/eval.toml
GESTALT_EVAL_CONFIG=path/to/eval.toml
```

Precedence is command-line override, environment override, then `harness/config/eval.toml`. Eval artifacts record the judge model plus the resolved config path and a content hash.

## Replay Flow

Time is virtual. `startLifeSimulation` moves an injected clock from event to next due wake, so `sleep(3600)` costs nothing and a week can replay in minutes.

1. Load `.env` and `.env.local`.
2. Validate the fixture and build a temporary GestaltHome.
3. Snapshot the home.
4. Create a mock connector and the model, with two independent sinks: compact production rollout records, and complete harness-only model exchange capture.
5. Deliver events on the virtual clock, letting wakes and sleeps run between them.
6. Snapshot the home and export every artifact.
7. Reconstruct each generation from rollout deltas and compare it with the request the harness captured.
8. Run fixture expectations through `assertions.ts`.

## Generated Artifacts

```text
harness/artifacts/<scenario-id>/
  wakes.json               every wake: reason, place, sleep, tokens, error
  connector-calls.json     what actually reached the mock platform
  session.json             bounded diagnostic view; not startup input
  session-journal.json     append-only journal records
  rollouts.json            production rollout records and summaries
  reconstructed-inputs.json  generation inputs rebuilt from deltas
  model-requests.json      captured request messages
  model-exchanges.json     complete step requests, responses, tool calls
  home-before.json         the home before
  home-after.json          the home after, including life/
  summary.json, report.md
  eval-inputs.json, eval-results.json, eval-report.md
  blobs/<sha256>
```

Every harness JSON artifact goes through the shared binary-aware writer, independent of `trace_binary_capture_enabled`. Binary values become content-addressed references under `blobs/`.

Artifacts are evidence, not source.

## Commands

Install `pnpm`-driven tooling as usual. Without `pnpm` on PATH, use the local binaries in `node_modules/.bin`.

```bash
pnpm run typecheck
```

```bash
pnpm --filter @gestalt/harness run verify:life
```

```bash
pnpm --filter @gestalt/harness run verify:migrate
```

```bash
pnpm --filter @gestalt/harness run verify:wake-model
```

```bash
pnpm --filter @gestalt/harness run eval:life
```

```bash
pnpm --filter @gestalt/harness run eval:soul
```

```bash
pnpm --filter @gestalt/harness run eval:replay-truth <replay out dir>
```

```bash
pnpm --filter @gestalt/harness run eval:stickers
```

```bash
pnpm --filter @gestalt/harness run eval:onebot
```

`life.verify.ts` takes a filter, such as `tsx src/life.verify.ts budget`. `eval.ts` takes fixture paths.

Other verifies cover config, prompts, stickers, inspect, rollouts, the transport, and the Live UI; `harness/package.json` lists them, and `packages/app` has the unit-level ones.

### Rhythm Replay

`journalReplay.ts` replays real traffic through the loop with the configured model. It answers how often it wakes, what it spends, and whether it speaks first. It cannot answer anything about relationships, because nobody reacts to what it says.

Production chat is private, so prefer `--rhythm`: run a stdlib Python script over ssh that prints only timestamps, pseudonyms, and whether the bot was called, and let the harness invent the words.

```bash
pnpm --filter @gestalt/harness run replay:journal -- --rhythm <rows.jsonl> --home fixtures/homes/simple-group-test --from <iso> --to <iso> --out <outside-the-repo>
```

`--journal` replays real text. Copying journals off the host and sending them to a model provider again needs the owner's decision, and the journal and its artifacts stay outside the repository.

### Build

```bash
pnpm run build
```

```bash
pnpm run verify:build
```

The app build keeps third-party npm dependencies external and bundles the workspace-owned `@gestalt/live-contracts` source into the App entry, so a production `pnpm deploy` layout never asks Node to execute TypeScript beneath `node_modules`. The build also loads the generated Fortress provider entry, and `verify:build` executes it as a plugin process and asserts its manifest.

The workspace dependency graph builds `@gestalt/trace` before `@gestalt/app`, and the App build copies the completed Trace UI into `packages/app/dist/live-ui/`. `verify:build` starts the generated app on a temporary port and proves the health API, HTML shell, and a built UI asset share one origin.

Clean generated build output before finishing work if `packages/app/dist/` was created.

## Adding A New Runtime Feature

1. State the behavior in artifact terms before coding.
2. Implement the smallest runtime change that expresses it.
3. Add or update a scenario fixture.
4. Extend `fixtureSchema.ts` and `assertions.ts` only when the fixture needs it.
5. Run the relevant `verify:*` command.
6. Read the artifacts yourself.
7. If the behavior is qualitative, run an `eval:*` command, ideally against the real model, and read the judge's reasoning.
8. Keep the fixture if it captures a product principle, bug fix, or important behavior.
9. Run `pnpm run typecheck`, and `pnpm run build` when runtime code changed.

Do not encode one-off behavior only inside a verify script. The durable source of behavior should be the fixture.

## Working From Artifacts

A green command proves only the assertions it covers. Useful questions:

- Did `wakes.json` show the reason and place you expected, and no `error`?
- Did the model actually see the needed context, or did the reply happen by luck?
- Did a held `say` show the model what arrived?
- Did a bot-visible side effect also appear as a self message, for future context?
- Do rollout records make the same behavior inspectable without the full provider request?
- Did `home-after.json` change as claimed, and were wrong claims removed rather than contradicted?
- Does a dream's commit trace back to diaries?

When an eval returns `warn` or `fail`, treat it as a behavioral finding. The fix may be a runtime bug, a prompt issue, missing evidence, weak fixture wording, or a rubric that no longer matches the product decision.

## Verify Versus Eval

- `verify:*` commands are deterministic artifact assertions.
- `eval:*` commands are LLM judgments over replay artifacts.

An eval result contains `label` (`pass`, `warn`, or `fail`), `score`, `summary`, `reasoning`, `strengths`, `concerns`, and `evidence`.

## What To Verify

For life behavior: wake reasons and offsets; that one wake enters one place; that a vibration respects `do_not_disturb` and the budget; that a restart keeps the schedule; that a held `say` sent nothing.

For model behavior: the request contains the relevant `me/`, place memory, and unread messages, and does not contain any other place's content; chat logs use minute-level time, stable ids, and raw CQ-bearing text; visible effects are tool calls, not text.

For home behavior: daytime wakes changed nothing but diaries; dreams changed what they claimed; oversized or failed dreams were reverted; each changed wake is one commit; secret-like files never appear in snapshots.

For trace behavior: one rollout per wake; the initial prompt and tool protocol appear once; every generation references the correct input `stateHash`; reconstruction matches the captured request; durable outbound start and finish bracket connector side effects, and a start without a finish is never retried; trace JSON holds no raw binary, local paths, or provider bodies.

## Development Rule

If a behavior matters enough to discuss, debug, or preserve, turn it into a fixture, eval, tool contract, trace assertion, or focused document.
