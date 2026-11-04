import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GestaltHome } from "../home/resolveGestaltHome";
import { DEFAULT_CONSTITUTION } from "../prompts/life";
import { WEB_PLACE, isValidPlaceSegment } from "./places";

const execGit = promisify(execFile);

export interface LifeFile {
  path: string;
  content: string;
}

export interface LifeLimits {
  meMaxBytes: number;
  placeMaxBytes: number;
}

export interface DiaryEntryFile extends LifeFile {
  place: string;
  date: string;
}

export interface LifeSizeViolation {
  path: string;
  bytes: number;
  limit: number;
}

/**
 * The bot's own repository. Identity and place knowledge live here, and every
 * wake that changed something becomes one commit, so `git log me/` is its
 * growth history and `git diff` shows exactly what a dream did to it.
 */
export interface LifeStore {
  readonly root: string;
  readonly meDir: string;
  readonly placesDir: string;
  ensureBorn(at: Date): Promise<void>;
  readConstitution(): Promise<string>;
  readMe(): Promise<LifeFile[]>;
  readPlaceMemory(place: string): Promise<LifeFile[]>;
  readRecentDiary(place: string, dates: readonly string[]): Promise<string>;
  appendDiary(place: string, date: string, entry: string): Promise<void>;
  readDiariesSince(date: string): Promise<DiaryEntryFile[]>;
  placeDir(place: string): string;
  hasArchive(): Promise<boolean>;
  ensurePlace(place: string): Promise<void>;
  findSizeViolations(limits: LifeLimits): Promise<LifeSizeViolation[]>;
  hasChanges(): Promise<boolean>;
  commit(message: string, at: Date): Promise<string | undefined>;
  revertUncommitted(): Promise<void>;
}

export interface CreateLifeStoreOptions {
  home: GestaltHome;
  authorName: string;
}

export function createLifeStore(options: CreateLifeStoreOptions): LifeStore {
  const root = options.home.lifeDir;
  const meDir = path.join(root, "me");
  const placesDir = path.join(root, "places");
  const constitutionPath = path.join(root, "constitution.md");

  async function git(
    args: readonly string[],
    at?: Date
  ): Promise<string> {
    const when = at?.toISOString();
    const { stdout } = await execGit(
      "git",
      [
        "-C",
        root,
        "-c",
        `user.name=${options.authorName}`,
        "-c",
        "user.email=life@gestalt.local",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.quotePath=false",
        "-c",
        `core.hooksPath=${path.join(root, ".git", "no-hooks")}`,
        ...args
      ],
      {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          ...(when
            ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
            : {})
        }
      }
    );
    return stdout;
  }

  function assertPlace(place: string): void {
    if (!isValidPlaceSegment(place)) {
      throw new Error(`Invalid place id: ${place}`);
    }
  }

  const store: LifeStore = {
    root,
    meDir,
    placesDir,

    async ensureBorn(at) {
      if (await exists(path.join(root, ".git"))) {
        return;
      }
      await mkdir(meDir, { recursive: true });
      await mkdir(path.join(placesDir, WEB_PLACE), { recursive: true });
      const webMemory = path.join(placesDir, WEB_PLACE, "memory.md");
      if (!(await exists(webMemory))) {
        await writeFile(webMemory, "", "utf8");
      }
      // A home migrated or seeded in advance already has a life to continue.
      if ((await readMarkdownFiles(meDir, "me")).length === 0) {
        await writeBirthPersona(options.home, meDir, constitutionPath);
      } else if (!(await exists(constitutionPath))) {
        await writeFile(
          constitutionPath,
          ensureTrailingNewline(DEFAULT_CONSTITUTION),
          "utf8"
        );
      }
      await git(["init", "--quiet", "--initial-branch=life"]);
      await store.commit("born", at);
    },

    async readConstitution() {
      return readFile(constitutionPath, "utf8");
    },

    readMe() {
      return readMarkdownFiles(meDir, "me");
    },

    async readPlaceMemory(place) {
      assertPlace(place);
      return readMarkdownFiles(
        path.join(placesDir, place),
        `places/${place}`
      );
    },

    async readRecentDiary(place, dates) {
      assertPlace(place);
      const parts: string[] = [];
      for (const date of dates) {
        const content = await readOptional(
          path.join(placesDir, place, "diary", `${date}.md`)
        );
        if (content?.trim()) {
          parts.push(`${date}\n${content.trim()}`);
        }
      }
      return parts.join("\n\n");
    },

    async appendDiary(place, date, entry) {
      assertPlace(place);
      const directory = path.join(placesDir, place, "diary");
      await mkdir(directory, { recursive: true });
      await appendFile(path.join(directory, `${date}.md`), `${entry}\n`, "utf8");
    },

    async readDiariesSince(date) {
      const entries: DiaryEntryFile[] = [];
      for (const place of await listDirectories(placesDir)) {
        const directory = path.join(placesDir, place, "diary");
        for (const fileName of await listFiles(directory)) {
          const fileDate = fileName.replace(/\.md$/, "");
          if (fileDate < date) {
            continue;
          }
          entries.push({
            place,
            date: fileDate,
            path: `places/${place}/diary/${fileName}`,
            content: await readFile(path.join(directory, fileName), "utf8")
          });
        }
      }
      return entries.sort((left, right) =>
        `${left.date}/${left.place}`.localeCompare(`${right.date}/${right.place}`)
      );
    },

    placeDir(place) {
      assertPlace(place);
      return path.join(placesDir, place);
    },

    async hasArchive() {
      return exists(path.join(placesDir, "archive"));
    },

    async ensurePlace(place) {
      await mkdir(store.placeDir(place), { recursive: true });
    },

    async findSizeViolations(limits) {
      const violations: LifeSizeViolation[] = [];
      const meBytes = await measureTree(meDir);
      if (meBytes > limits.meMaxBytes) {
        violations.push({
          path: "me",
          bytes: meBytes,
          limit: limits.meMaxBytes
        });
      }
      for (const place of await listDirectories(placesDir)) {
        // Migrated memory is waiting to be sorted, not something being carried.
        if (place === "archive") {
          continue;
        }
        const bytes = await measureTree(path.join(placesDir, place), "diary");
        if (bytes > limits.placeMaxBytes) {
          violations.push({
            path: `places/${place}`,
            bytes,
            limit: limits.placeMaxBytes
          });
        }
      }
      return violations;
    },

    async hasChanges() {
      return (await git(["status", "--porcelain"])).trim().length > 0;
    },

    async commit(message, at) {
      if (!(await store.hasChanges())) {
        return undefined;
      }
      await git(["add", "--all"]);
      await git(["commit", "--quiet", "-m", message], at);
      return (await git(["rev-parse", "HEAD"])).trim();
    },

    async revertUncommitted() {
      await git(["reset", "--hard", "--quiet", "HEAD"]);
      await git(["clean", "-fd", "--quiet"]);
    }
  };

  return store;
}

async function writeBirthPersona(
  home: GestaltHome,
  meDir: string,
  constitutionPath: string
): Promise<void> {
  const personaFiles = await listFiles(home.personaDir);
  let constitution = DEFAULT_CONSTITUTION;
  let wroteIdentity = false;
  for (const fileName of personaFiles) {
    const source = path.join(home.personaDir, fileName);
    if (fileName.toLowerCase() === "constitution.md") {
      constitution = await readFile(source, "utf8");
      continue;
    }
    if (!/\.(md|markdown|txt)$/i.test(fileName)) {
      continue;
    }
    await cp(source, path.join(meDir, fileName.replace(/\.[^.]+$/, ".md")));
    wroteIdentity = true;
  }
  await writeFile(constitutionPath, ensureTrailingNewline(constitution), "utf8");
  if (!wroteIdentity) {
    await writeFile(path.join(meDir, "index.md"), "", "utf8");
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function readMarkdownFiles(
  directory: string,
  prefix: string
): Promise<LifeFile[]> {
  const files: LifeFile[] = [];
  for (const fileName of (await listFiles(directory)).sort()) {
    if (!/\.md$/i.test(fileName)) {
      continue;
    }
    files.push({
      path: `${prefix}/${fileName}`,
      content: await readFile(path.join(directory, fileName), "utf8")
    });
  }
  return files;
}

async function measureTree(
  directory: string,
  skipDirectory?: string
): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== skipDirectory) {
        total += await measureTree(target);
      }
    } else if (entry.isFile()) {
      total += (await stat(target)).size;
    }
  }
  return total;
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function removeLifeForTest(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
