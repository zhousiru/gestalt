import {
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  defineCommand,
  type CustomCommand
} from "just-bash";
import type { StickerService } from "../stickers/service";
import {
  createActionBashToolScope,
  resolvePackagedAgentBrowserConfigPath,
  type NativeCommandTarget
} from "../tools/agentBrowser";
import type { BashCommandResult } from "../tools/bash";
import { WEB_PLACE } from "./places";
import type { LifeStore } from "./store";

export type WakeMounts =
  | { kind: "phone" }
  | { kind: "place"; place: string; chat: boolean }
  | { kind: "dream" };

export interface WakeBash {
  exec(command: string, signal?: AbortSignal): Promise<BashCommandResult>;
  dispose(): Promise<void>;
}

export interface CreateWakeBashInput {
  wakeId: string;
  life: LifeStore;
  mounts: WakeMounts;
  stickers?: StickerService | undefined;
  agentBrowserTarget?: NativeCommandTarget;
}

/**
 * One wake's shell. The mounts are the rule: in the day nothing of the bot's
 * home is writable, and only a dream can reach every place.
 */
export function createWakeBash(input: CreateWakeBashInput): WakeBash {
  const scope = createActionBashToolScope({
    namespace: "gestalt",
    sessionId: `gestalt-${input.wakeId}`,
    provider: "fortress",
    configPath: resolvePackagedAgentBrowserConfigPath(),
    fs: createWakeFs(input.life, input.mounts),
    // Going online is a choice with a place and a diary, not a phone-side task.
    browser: input.mounts.kind === "place",
    customCommands: createWakeCommands(input),
    ...(input.agentBrowserTarget
      ? { agentBrowserTarget: input.agentBrowserTarget }
      : {})
  });
  return {
    exec: (command, signal) => scope.exec(command, signal),
    async dispose() {
      await scope.dispose();
    }
  };
}

function createWakeFs(life: LifeStore, mounts: WakeMounts): MountableFs {
  const readOnly = (root: string): OverlayFs =>
    new OverlayFs({ root, mountPoint: "/", readOnly: true });
  if (mounts.kind === "dream") {
    return new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        {
          mountPoint: "/me",
          filesystem: new ReadWriteFs({ root: life.meDir })
        },
        {
          mountPoint: "/places",
          filesystem: new ReadWriteFs({ root: life.placesDir })
        }
      ]
    });
  }
  return new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      { mountPoint: "/me", filesystem: readOnly(life.meDir) },
      {
        mountPoint: "/web",
        filesystem: readOnly(life.placeDir(WEB_PLACE))
      },
      ...(mounts.kind === "place" && mounts.chat
        ? [
            {
              mountPoint: "/here",
              filesystem: readOnly(life.placeDir(mounts.place))
            }
          ]
        : [])
    ]
  });
}

function createWakeCommands(input: CreateWakeBashInput): CustomCommand[] {
  const stickers = input.stickers;
  if (!stickers || input.mounts.kind === "dream") {
    return [];
  }
  return [
    defineCommand("sticker", async (args) => {
      const [subcommand, ...rest] = args;
      const query = rest.join(" ").trim();
      if (subcommand !== "search" || !query) {
        return {
          stdout: "",
          stderr: "usage: sticker search <what you feel>\n",
          exitCode: 2
        };
      }
      const results = await stickers.search({
        query,
        mode: "search",
        seed: `${input.wakeId}:${query}`,
        source: "tool",
        agentTraceId: input.wakeId
      });
      return {
        stdout: results
          .map((sticker) => `${sticker.stickerId}\t${sticker.visual}\n`)
          .join(""),
        stderr: "",
        exitCode: 0
      };
    })
  ];
}
