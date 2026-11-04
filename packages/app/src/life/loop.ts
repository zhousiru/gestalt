import { randomUUID } from "node:crypto";
import { isSelfMessageEvent } from "../events/helpers";
import type { SessionEventRecord } from "../session/schemas";
import { getConversationKey } from "../session/store";
import type { LifeClock } from "./clock";
import { isCallingBot, readPhone, selectUnreadRecords } from "./phone";
import { placeIdForConversation } from "./places";
import { loadLifeState, saveLifeState, type LifeState } from "./state";
import { dateInDay, nextDayStart } from "./time";
import {
  runWake,
  type WakeDependencies,
  type WakeReason,
  type WakeResult
} from "./wake";

const MAX_FAILURE_BACKOFF_SECONDS = 60 * 60;
const RECENT_WAKES = 256;

export type LifePhase = "unborn" | "sleeping" | "working" | "typing" | "stopped";

export interface LifeLoop {
  readonly phase: LifePhase;
  readonly wakes: readonly WakeResult[];
  readonly wakeCount: number;
  start(): void;
  stop(): Promise<void>;
  /** A newly appended message. Calls wake it; everything else just waits. */
  notice(record: SessionEventRecord): void;
  /** Resolves when nothing is running: asleep, or waiting out typing time. */
  whenQuiescent(): Promise<void>;
  state(): LifeState | undefined;
}

export type LifeLoopDependencies = Omit<WakeDependencies, "onPhase">;

export function createLifeLoop(dependencies: LifeLoopDependencies): LifeLoop {
  const { clock, config, life, sessionStore, timezone } = dependencies;
  const wakes: WakeResult[] = [];
  let wakeCount = 0;
  let phase: LifePhase = "unborn";
  let state: LifeState | undefined;
  let stopped = false;
  let sleepController: AbortController | undefined;
  let vibrated = false;
  let consecutiveFailures = 0;
  let running: Promise<void> | undefined;
  let quiescenceWaiters: Array<() => void> = [];

  const setPhase = (next: LifePhase): void => {
    phase = next;
    if (isQuiescent()) {
      const waiters = quiescenceWaiters;
      quiescenceWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  };

  const isQuiescent = (): boolean =>
    phase === "sleeping" || phase === "typing" || phase === "stopped";

  const persist = async (): Promise<void> => {
    if (state) {
      await saveLifeState(dependencies.home.lifeStatePath, state);
    }
  };

  const today = (at: Date): string =>
    dateInDay(at, config.dayStartHour, timezone);

  const rollBudget = (now: Date): void => {
    if (state && state.budget.day !== today(now)) {
      state.budget = { day: today(now), usedTokens: 0 };
    }
  };

  const budgetSpent = (): boolean =>
    state !== undefined &&
    state.budget.usedTokens >= config.dailyTokenBudget;

  const dreamDue = (now: Date): boolean =>
    state !== undefined &&
    now.valueOf() - Date.parse(state.lastDreamAt) >=
      config.dreamIntervalHours * 3_600_000;

  const nextWake = (now: Date): { at: Date; reason?: WakeReason } => {
    rollBudget(now);
    if (budgetSpent()) {
      if (state?.spentDreamDay !== today(now)) {
        return { at: now, reason: "budget_spent" };
      }
      if (state) {
        state.doNotDisturb = true;
      }
      return { at: nextDayStart(now, config.dayStartHour, timezone) };
    }
    const scheduled = state?.nextWakeAt ? new Date(state.nextWakeAt) : now;
    return { at: scheduled };
  };

  const live = async (): Promise<void> => {
    const bornAt = clock.now();
    await life.ensureBorn(bornAt);
    state =
      (await loadLifeState(dependencies.home.lifeStatePath)) ??
      createInitialState(bornAt, today(bornAt));
    let booting = true;

    while (!stopped) {
      const now = clock.now();
      const next = nextWake(now);
      await persist();

      let reason: WakeReason;
      if (next.reason) {
        reason = next.reason;
      } else if (next.at.valueOf() <= now.valueOf()) {
        reason = booting ? "boot" : "timer";
      } else {
        reason = await sleepUntil(next.at);
      }
      booting = false;
      if (stopped) {
        break;
      }

      await wake(reason);
    }
    setPhase("stopped");
  };

  const sleepUntil = async (at: Date): Promise<WakeReason> => {
    const controller = new AbortController();
    sleepController = controller;
    vibrated = false;
    setPhase("sleeping");
    await clock.sleep(at.valueOf() - clock.now().valueOf(), controller.signal);
    sleepController = undefined;
    return vibrated ? "vibration" : "timer";
  };

  const wake = async (requested: WakeReason): Promise<void> => {
    if (!state) {
      return;
    }
    const now = clock.now();
    rollBudget(now);
    const forcedByBudget = requested === "budget_spent";
    const dream = forcedByBudget || dreamDue(now);
    const reason: WakeReason =
      dream && !forcedByBudget ? "dream_due" : requested;
    state.doNotDisturb = false;
    state.lastWakeAt = now.toISOString();
    setPhase("working");

    let result: WakeResult;
    try {
      result = await runWake(
        {
          ...dependencies,
          onPhase(next) {
            setPhase(next);
          }
        },
        {
          reason,
          state,
          dream,
          ...(forcedByBudget
            ? { dreamReason: "You have used up today. Sort things out, then sleep until tomorrow." }
            : dream
              ? { dreamReason: "It has been a while since you dreamed." }
              : {})
        }
      );
    } catch (error) {
      result = failedWake(reason, now, error);
      dependencies.liveEvents?.publish("agent.run.failed", {
        entity: { kind: "signal", id: "wake_failed" },
        status: "failed",
        summary: result.error ?? "wake failed"
      });
    }

    wakeCount += 1;
    wakes.push(result);
    if (wakes.length > RECENT_WAKES) {
      wakes.shift();
    }
    settle(result, dream);
    await persist();
    await sessionStore.recordWake({
      id: result.id,
      rolloutId: result.rolloutId,
      reason: result.reason,
      kind: result.kind,
      ...(result.place ? { place: result.place } : {}),
      status: result.status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      sleepSeconds: secondsUntil(state.nextWakeAt),
      doNotDisturb: state.doNotDisturb,
      said: result.said,
      held: result.held,
      tokens: result.usage.inputTokens + result.usage.outputTokens,
      ...(result.commit ? { commit: result.commit } : {}),
      ...(result.error ? { error: result.error.slice(0, 500) } : {})
    });
  };

  const secondsUntil = (at: string | undefined): number =>
    at
      ? Math.max(0, Math.round((Date.parse(at) - clock.now().valueOf()) / 1000))
      : 0;

  /** Everything that follows from how a wake ended. */
  const settle = (result: WakeResult, dream: boolean): void => {
    if (!state) {
      return;
    }
    const now = clock.now();
    state.budget.usedTokens +=
      result.usage.inputTokens + result.usage.outputTokens;
    state.lastSleptAt = now.toISOString();
    if (result.kind === "dream" && result.status === "completed") {
      state.lastDreamAt = now.toISOString();
    }
    if (result.reason === "budget_spent") {
      // Even a failed dream counts, or an exhausted day would retry forever.
      state.spentDreamDay = today(now);
    }

    if (result.status === "failed") {
      consecutiveFailures += 1;
      state.doNotDisturb = false;
      state.nextWakeAt = new Date(
        now.valueOf() +
          Math.min(
            MAX_FAILURE_BACKOFF_SECONDS,
            60 * 2 ** (consecutiveFailures - 1)
          ) *
            1000
      ).toISOString();
      return;
    }
    consecutiveFailures = 0;

    let seconds = clampSleep(
      result.requestedSleepSeconds ?? config.defaultSleepSeconds
    );
    state.doNotDisturb = result.doNotDisturb;
    const calledDuringWake = readPhone({
      sessionStore,
      state,
      allowedGroupIds: dependencies.allowedGroupIds
    }).places.some(
      (entry) =>
        entry.called &&
        (dream ||
          (entry.lastMessageAt !== undefined &&
            entry.lastMessageAt >= result.startedAt))
    );
    if (calledDuringWake && !state.doNotDisturb) {
      seconds = Math.min(seconds, config.minSleepSeconds);
    }
    state.nextWakeAt = new Date(now.valueOf() + seconds * 1000).toISOString();
  };

  const clampSleep = (seconds: number): number =>
    Math.min(
      config.maxSleepSeconds,
      Math.max(config.minSleepSeconds, Math.round(seconds))
    );

  return {
    get phase() {
      return phase;
    },
    get wakes() {
      return wakes;
    },
    get wakeCount() {
      return wakeCount;
    },

    start() {
      running ??= live().catch((error: unknown) => {
        dependencies.liveEvents?.publish("agent.run.failed", {
          entity: { kind: "signal", id: "life_loop_failed" },
          status: "failed",
          summary: error instanceof Error ? error.message : String(error)
        });
        setPhase("stopped");
        throw error;
      });
    },

    async stop() {
      stopped = true;
      sleepController?.abort();
      await running;
      setPhase("stopped");
    },

    notice(record) {
      if (
        !state ||
        record.event.type !== "MessageReceived" ||
        isSelfMessageEvent(record.event)
      ) {
        return;
      }
      const conversation = record.event.conversation;
      const records = sessionStore.getEvents(conversation);
      if (!isCallingBot(record, records)) {
        return;
      }
      const unread = selectUnreadRecords(
        records,
        state.lastRead[placeIdForConversation(conversation)]
      );
      if (!unread.some((candidate) => candidate.id === record.id)) {
        return;
      }
      if (state.doNotDisturb || budgetSpent()) {
        return;
      }
      vibrated = true;
      sleepController?.abort();
    },

    whenQuiescent() {
      if (isQuiescent()) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        quiescenceWaiters.push(resolve);
      });
    },

    state: () => state
  };
}

function createInitialState(bornAt: Date, day: string): LifeState {
  return {
    bornAt: bornAt.toISOString(),
    doNotDisturb: false,
    lastDreamAt: bornAt.toISOString(),
    lastRead: {},
    budget: { day, usedTokens: 0 }
  };
}

function failedWake(
  reason: WakeReason,
  now: Date,
  error: unknown
): WakeResult {
  const id = randomUUID();
  return {
    id,
    rolloutId: id,
    reason,
    kind: "day",
    status: "failed",
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    doNotDisturb: false,
    said: 0,
    held: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    proposals: [],
    toolResults: [],
    reverted: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

export type { LifeClock };
export { getConversationKey };
