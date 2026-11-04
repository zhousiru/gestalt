import { formatZonedDateTime } from "../context/time";

/**
 * The bot's day ends when it would go to bed, not at midnight, so diaries and
 * the token budget keep a late-night conversation inside one day.
 */
export function dateInDay(
  at: Date,
  dayStartHour: number,
  timezone: string
): string {
  return formatZonedDateTime(
    new Date(at.valueOf() - dayStartHour * 3_600_000),
    timezone
  ).date;
}

/** The next moment the day rolls over, at or after `at`. */
export function nextDayStart(
  at: Date,
  dayStartHour: number,
  timezone: string
): Date {
  const today = dateInDay(at, dayStartHour, timezone);
  let probe = at.valueOf();
  // Timezones can shift by an hour, so step to the boundary instead of adding 24h.
  for (let step = 0; step < 26 * 12; step += 1) {
    probe += 5 * 60_000;
    if (dateInDay(new Date(probe), dayStartHour, timezone) !== today) {
      return new Date(Math.floor(probe / 300_000) * 300_000);
    }
  }
  return new Date(at.valueOf() + 86_400_000);
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 90) {
    return `${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours} hours`;
  }
  return `${Math.round(hours / 24)} days`;
}
