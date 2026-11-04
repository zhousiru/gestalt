import type { Connector } from "../connectors/types";
import type { GestaltConfig } from "../home/loadConfig";
import type { GestaltHome } from "../home/resolveGestaltHome";
import type { LiveEventSink } from "../live/viewTypes";
import { createAiStickerAnalyzer, createAiStickerEmbedder } from "./ai";
import { createStickerVectorIndex } from "./lance";
import { createStickerLogger } from "./logger";
import { createStickerMediaResolver } from "./media";
import { createStickerService, type StickerService } from "./service";
import { createStickerStore } from "./store";

export function isStickerSubsystemConfigured(config: GestaltConfig): boolean {
  return (
    Boolean(config.flatValues.embedding_model_name) ||
    config.flatValues.sticker_scraping_enabled === true
  );
}

export async function createConfiguredStickerService(input: {
  home: GestaltHome;
  config: GestaltConfig;
  connector: Connector;
  liveEvents?: LiveEventSink;
  now?: () => Date;
  fetch?: typeof fetch;
}): Promise<StickerService> {
  const logger = createStickerLogger(input.home);
  const embedder = createAiStickerEmbedder(input.config, {
    ...(input.fetch ? { fetch: input.fetch } : {})
  });
  const vectorIndex = await createStickerVectorIndex({
    directory: input.home.stickerLanceDbDir,
    embeddingId: embedder.id
  });
  return createStickerService({
    home: input.home,
    connector: input.connector,
    store: createStickerStore(input.home),
    logger,
    mediaResolver: createStickerMediaResolver({
      connector: input.connector,
      ...(input.fetch ? { fetch: input.fetch } : {})
    }),
    analyzer: createAiStickerAnalyzer(input.config, {
      ...(input.fetch ? { fetch: input.fetch } : {})
    }),
    embedder,
    vectorIndex,
    configuredEnabled: readStickerScrapingEnabled(input.config),
    processingConcurrency: readStickerProcessingConcurrency(input.config),
    ...(input.liveEvents ? { liveEvents: input.liveEvents } : {}),
    ...(input.now ? { now: input.now } : {})
  });
}

export function readStickerScrapingEnabled(config: GestaltConfig): boolean {
  const value = config.flatValues.sticker_scraping_enabled;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("sticker_scraping_enabled must be a boolean.");
  }
  return value;
}

export function readStickerProcessingConcurrency(config: GestaltConfig): number {
  const value = config.flatValues.sticker_processing_concurrency;
  if (value === undefined) {
    return 1;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error(
      "sticker_processing_concurrency must be an integer between 1 and 32."
    );
  }
  return parsed;
}

export function readOperatorUserIds(config: GestaltConfig): Set<string> {
  const value = config.flatValues.operator_user_ids;
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new Error("operator_user_ids must be an array of user ids.");
  }
  return new Set(value.map((entry) => String(entry)));
}
