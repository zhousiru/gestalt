import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONSTITUTION } from "../prompts/life";
import type { GestaltHome } from "../home/resolveGestaltHome";
import { saveLifeState } from "./state";

export const ARCHIVE_PLACE = "archive";

/** Keys the life loop replaced. They are dropped; everything else is kept. */
const RETIRED_CONFIG_KEY =
  /^(dreaming_enabled|trigger_[a-z_]+|agent_loop_[a-z_]+|sticker_recommendation_[a-z_]+)\s*=/;

export interface MigrateHomeResult {
  skipped: boolean;
  meFiles: string[];
  archivedMemoryFiles: number;
  droppedConfigLines: string[];
}

/** A home with old memory and no life would otherwise be born fresh. */
export async function needsLifeMigration(home: GestaltHome): Promise<boolean> {
  return (
    (await exists(path.join(home.root, "memories"))) &&
    !(await hasLife(home))
  );
}

/**
 * Moves a pre-life home into the life layout. Old memory mixes every group
 * together, so it must not enter `me/`, where it would load everywhere. It goes
 * to `places/archive/`, which only dreams can see, and the first dream sorts it
 * into the right places. Originals stay where they are.
 */
export async function migrateHomeToLife(
  home: GestaltHome,
  now: Date
): Promise<MigrateHomeResult> {
  const meDir = path.join(home.lifeDir, "me");
  if (await hasLife(home)) {
    return {
      skipped: true,
      meFiles: [],
      archivedMemoryFiles: 0,
      droppedConfigLines: []
    };
  }
  await mkdir(meDir, { recursive: true });

  const meFiles: string[] = [];
  for (const fileName of await listFiles(home.personaDir)) {
    // The old boundaries deflected sincere questions about being an AI. The
    // constitution replaces them.
    if (!/\.(md|markdown|txt)$/i.test(fileName) || /boundar/i.test(fileName)) {
      continue;
    }
    const target = fileName.replace(/\.[^.]+$/, ".md");
    // Personas were written for a tool that no longer exists.
    await writeFile(
      path.join(meDir, target),
      (await readFile(path.join(home.personaDir, fileName), "utf8")).replaceAll(
        "send_group_message",
        "say"
      ),
      "utf8"
    );
    meFiles.push(target);
  }
  await writeFile(
    path.join(home.lifeDir, "constitution.md"),
    `${DEFAULT_CONSTITUTION}\n`,
    "utf8"
  );

  const memoriesDir = path.join(home.root, "memories");
  const archiveDir = path.join(home.lifeDir, "places", ARCHIVE_PLACE);
  let archivedMemoryFiles = 0;
  if (await exists(memoriesDir)) {
    await mkdir(archiveDir, { recursive: true });
    await cp(memoriesDir, archiveDir, { recursive: true });
    archivedMemoryFiles = await countFiles(archiveDir);
  }

  const droppedConfigLines = await retireConfigKeys(home.configPath);

  // Overdue on purpose: the first thing it does is dream through the archive.
  await saveLifeState(home.lifeStatePath, {
    bornAt: now.toISOString(),
    doNotDisturb: false,
    lastDreamAt: new Date(now.valueOf() - 30 * 86_400_000).toISOString(),
    lastRead: {},
    budget: { day: now.toISOString().slice(0, 10), usedTokens: 0 }
  });

  return {
    skipped: false,
    meFiles,
    archivedMemoryFiles,
    droppedConfigLines
  };
}

/** The repository only appears on first start, so migration marks the home this way. */
function hasLife(home: GestaltHome): Promise<boolean> {
  return exists(path.join(home.lifeDir, "constitution.md"));
}

async function retireConfigKeys(configPath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  const dropped: string[] = [];
  const kept = raw.split(/\r?\n/).filter((line) => {
    if (RETIRED_CONFIG_KEY.test(line.trim())) {
      dropped.push(line.trim());
      return false;
    }
    return true;
  });
  if (dropped.length > 0) {
    await writeFile(`${configPath}.pre-life`, raw, "utf8");
    const temporaryPath = `${configPath}.tmp`;
    await writeFile(temporaryPath, kept.join("\n"), "utf8");
    await rm(configPath);
    await rename(temporaryPath, configPath);
  }
  return dropped;
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    total += entry.isDirectory()
      ? await countFiles(path.join(directory, entry.name))
      : 1;
  }
  return total;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
