import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const LastReadSchema = z
  .object({
    eventId: z.string().min(1),
    at: z.string().min(1)
  })
  .strict();

export const LifeStateSchema = z
  .object({
    bornAt: z.string().min(1),
    nextWakeAt: z.string().min(1).optional(),
    doNotDisturb: z.boolean(),
    lastWakeAt: z.string().min(1).optional(),
    lastSleptAt: z.string().min(1).optional(),
    lastDreamAt: z.string().min(1),
    lastRead: z.record(z.string(), LastReadSchema),
    budget: z
      .object({
        day: z.string().min(1),
        usedTokens: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export type LifeState = z.infer<typeof LifeStateSchema>;

/**
 * The only thing that survives a restart besides the journal and the home:
 * when it planned to wake, how far it has read, and what it has spent.
 */
export async function loadLifeState(
  statePath: string
): Promise<LifeState | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    return undefined;
  }
  return LifeStateSchema.parse(JSON.parse(raw));
}

export async function saveLifeState(
  statePath: string,
  state: LifeState
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  await rename(temporaryPath, statePath);
}
