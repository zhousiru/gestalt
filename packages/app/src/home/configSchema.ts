import { parse } from "smol-toml";
import { z, type ZodIssue } from "zod";

export type GestaltConfigValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

const nonEmptyString = z.string().trim().min(1);
const clearableString = z.string().transform((value) => value.trim());
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const id = z.union([nonEmptyString, nonNegativeInteger]);
const toolChoice = z.union([
  z.enum(["required", "auto", "none"]),
  z.literal("")
]);
const promptCacheTtl = z.union([z.enum(["5m", "1h"]), z.literal("")]);
const routingSort = z.union([
  z.enum(["price", "throughput", "latency"]),
  z.literal("")
]);
const timezone = nonEmptyString.refine(isValidTimezone, {
  message: "must be a valid IANA timezone"
});

function languageModelFields(
  prefix: "main_model" | "sub_model"
): Record<string, z.ZodType> {
  return {
    [`${prefix}_provider`]: nonEmptyString.optional(),
    [`${prefix}_base_url`]: nonEmptyString.optional(),
    [`${prefix}_name`]: nonEmptyString.optional(),
    [`${prefix}_api_key`]: nonEmptyString.optional(),
    [`${prefix}_api_key_env`]: nonEmptyString.optional(),
    [`${prefix}_temperature`]: z.number().finite().nonnegative().optional(),
    [`${prefix}_max_steps`]: positiveInteger.optional(),
    [`${prefix}_routing_order`]: clearableString.optional(),
    [`${prefix}_routing_allow_fallbacks`]: z.boolean().optional(),
    [`${prefix}_routing_sort`]: routingSort.optional(),
    [`${prefix}_thinking`]: clearableString.optional(),
    [`${prefix}_tool_choice`]: toolChoice.optional(),
    [`${prefix}_prompt_cache_enabled`]: z.boolean().optional(),
    [`${prefix}_prompt_cache_ttl`]: promptCacheTtl.optional()
  };
}

export const gestaltConfigSchema = z
  .strictObject({
    connector: z
      .enum(["mock", "onebot-forward-ws", "onebot-reverse-ws"])
      .optional(),
    allowedgroups: z.array(id).optional(),

    onebot_ws_url: nonEmptyString.optional(),
    onebot_host: nonEmptyString.optional(),
    onebot_port: positiveInteger.optional(),
    onebot_path: nonEmptyString.optional(),
    onebot_access_token_env: nonEmptyString.optional(),

    live_enabled: z.boolean().optional(),
    live_host: nonEmptyString.optional(),
    live_port: positiveInteger.optional(),

    ...languageModelFields("main_model"),
    ...languageModelFields("sub_model"),

    embedding_model_provider: nonEmptyString.optional(),
    embedding_model_base_url: nonEmptyString.optional(),
    embedding_model_name: nonEmptyString.optional(),
    embedding_model_id: nonEmptyString.optional(),
    embedding_model_api_key: nonEmptyString.optional(),
    embedding_model_api_key_env: nonEmptyString.optional(),
    embedding_model_dimensions: positiveInteger.optional(),
    embedding_model_routing_order: clearableString.optional(),
    embedding_model_routing_allow_fallbacks: z.boolean().optional(),

    sticker_scraping_enabled: z.boolean().optional(),
    sticker_processing_concurrency: z.number().int().min(1).max(32).optional(),
    operator_user_ids: z.array(id).optional(),

    timezone: timezone.optional(),
    bot_user_id: nonEmptyString.optional(),
    bot_display_name: nonEmptyString.optional(),
    session_recent_history_hours: positiveInteger.optional(),
    context_recent_message_count: nonNegativeInteger.max(500).optional(),
    trace_binary_capture_enabled: z.boolean().optional(),
    life_daily_token_budget: positiveInteger.optional(),
    life_day_start_hour: z.number().int().min(0).max(23).optional(),
    life_min_sleep_seconds: positiveInteger.optional(),
    life_max_sleep_seconds: positiveInteger.optional(),
    life_default_sleep_seconds: positiveInteger.optional(),
    life_bash_timeout_seconds: positiveInteger.optional(),
    life_dream_interval_hours: positiveInteger.optional(),
    life_typing_ms_per_char: nonNegativeInteger.optional(),
    life_typing_min_ms: nonNegativeInteger.optional(),
    life_typing_max_ms: nonNegativeInteger.optional(),
    life_unread_limit: positiveInteger.optional(),
    life_wake_max_steps: positiveInteger.optional(),
    life_dream_max_steps: positiveInteger.optional(),
    life_me_max_bytes: positiveInteger.optional(),
    life_place_max_bytes: positiveInteger.optional()
  })
  .superRefine((config, context) => {
    for (const prefix of [
      "main_model",
      "sub_model",
      "embedding_model"
    ] as const) {
      const apiKey = `${prefix}_api_key` as keyof typeof config;
      const apiKeyEnv = `${prefix}_api_key_env` as keyof typeof config;
      if (config[apiKey] !== undefined && config[apiKeyEnv] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [apiKey],
          message: `cannot be used together with ${String(apiKeyEnv)}`
        });
      }
    }
    const minSleep = config.life_min_sleep_seconds;
    const maxSleep = config.life_max_sleep_seconds;
    if (minSleep !== undefined && maxSleep !== undefined && maxSleep < minSleep) {
      context.addIssue({
        code: "custom",
        path: ["life_max_sleep_seconds"],
        message: "must be greater than or equal to life_min_sleep_seconds"
      });
    }
  });

export function parseGestaltConfig(
  raw: string,
  configPath = "config.toml"
): Record<string, GestaltConfigValue> {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid TOML in ${configPath}: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const result = gestaltConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map(formatIssue).join("\n- ");
    throw new Error(`Invalid Gestalt config ${configPath}:\n- ${details}`);
  }

  return result.data as Record<string, GestaltConfigValue>;
}

function formatIssue(issue: ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unknown key${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}`;
  }
  const location = issue.path.length > 0 ? issue.path.join(".") : "config";
  return `${location}: ${issue.message}`;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
