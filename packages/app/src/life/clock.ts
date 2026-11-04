/**
 * All life-loop time comes from here, so a harness can replay a week of chat in
 * minutes while the bot's sleep schedule stays exactly what it chose.
 */
export interface LifeClock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function createSystemClock(now: () => Date = () => new Date()): LifeClock {
  return {
    now,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const finish = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, ms));
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
  };
}

export interface VirtualClock extends LifeClock {
  /** The earliest pending sleeper, if any. */
  nextDueAt(): number | undefined;
  /** Moves time forward and releases every sleeper due at or before it. */
  advanceTo(at: Date | number): void;
}

interface VirtualSleeper {
  dueAt: number;
  resolve(): void;
}

export function createVirtualClock(start: Date | string): VirtualClock {
  let current = new Date(start).valueOf();
  const sleepers = new Set<VirtualSleeper>();

  return {
    now: () => new Date(current),

    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const sleeper: VirtualSleeper = {
          dueAt: current + Math.max(0, ms),
          resolve() {
            sleepers.delete(sleeper);
            signal?.removeEventListener("abort", sleeper.resolve);
            resolve();
          }
        };
        sleepers.add(sleeper);
        signal?.addEventListener("abort", sleeper.resolve, { once: true });
      });
    },

    nextDueAt() {
      let earliest: number | undefined;
      for (const sleeper of sleepers) {
        if (earliest === undefined || sleeper.dueAt < earliest) {
          earliest = sleeper.dueAt;
        }
      }
      return earliest;
    },

    advanceTo(at) {
      const target = new Date(at).valueOf();
      if (target > current) {
        current = target;
      }
      for (const sleeper of Array.from(sleepers)) {
        if (sleeper.dueAt <= current) {
          sleeper.resolve();
        }
      }
    }
  };
}
