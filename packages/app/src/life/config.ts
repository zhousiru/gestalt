import type { GestaltConfig } from "../home/loadConfig";

export interface LifeConfig {
  dailyTokenBudget: number;
  dayStartHour: number;
  minSleepSeconds: number;
  maxSleepSeconds: number;
  defaultSleepSeconds: number;
  dreamIntervalHours: number;
  typingMsPerChar: number;
  typingMinMs: number;
  typingMaxMs: number;
  unreadLimit: number;
  contextMessageCount: number;
  wakeMaxSteps: number;
  dreamMaxSteps: number;
  meMaxBytes: number;
  placeMaxBytes: number;
}

export function readLifeConfig(config: GestaltConfig): LifeConfig {
  const flat = config.flatValues;
  const read = (key: string, fallback: number): number => {
    const value = flat[key];
    return typeof value === "number" ? value : fallback;
  };
  return {
    dailyTokenBudget: read("life_daily_token_budget", 2_000_000),
    dayStartHour: read("life_day_start_hour", 5),
    minSleepSeconds: read("life_min_sleep_seconds", 15),
    maxSleepSeconds: read("life_max_sleep_seconds", 8 * 60 * 60),
    defaultSleepSeconds: read("life_default_sleep_seconds", 10 * 60),
    dreamIntervalHours: read("life_dream_interval_hours", 24),
    typingMsPerChar: read("life_typing_ms_per_char", 150),
    typingMinMs: read("life_typing_min_ms", 800),
    typingMaxMs: read("life_typing_max_ms", 8_000),
    unreadLimit: read("life_unread_limit", 40),
    contextMessageCount: read("context_recent_message_count", 12),
    wakeMaxSteps: read("life_wake_max_steps", 16),
    dreamMaxSteps: read("life_dream_max_steps", 64),
    meMaxBytes: read("life_me_max_bytes", 24 * 1024),
    placeMaxBytes: read("life_place_max_bytes", 24 * 1024)
  };
}

export function readBotIdentity(config: GestaltConfig): {
  displayName: string;
} {
  const name = config.flatValues.bot_display_name;
  return { displayName: typeof name === "string" ? name : "Gestalt" };
}
