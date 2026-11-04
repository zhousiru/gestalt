import { z } from "zod";

const ScriptedStepSchema = z
  .object({
    tool: z.enum(["look", "say", "react", "sleep", "bash"]),
    input: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const ScenarioModelSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("scripted"),
      /** One list of steps per wake. Later wakes just go back to sleep. */
      wakes: z.array(z.array(ScriptedStepSchema)).default([]),
      usagePerStep: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative()
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("configured_ai_sdk")
    })
    .strict()
]);

export const ScenarioMessageSchema = z
  .object({
    /** Seconds after the scenario starts. */
    at: z.number().nonnegative(),
    conversationId: z.string().min(1),
    conversationName: z.string().min(1).optional(),
    conversationKind: z.enum(["group", "private"]).default("group"),
    senderId: z.string().min(1),
    senderName: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    text: z.string(),
    replyToMessageId: z.string().min(1).optional(),
    mentionsBot: z.boolean().default(false)
  })
  .strict();

const FileExpectationSchema = z
  .object({
    path: z.string().min(1),
    contains: z.string().min(1)
  })
  .strict();

export const ScenarioExpectationsSchema = z
  .object({
    wakes: z
      .object({
        count: z.number().int().nonnegative().optional(),
        minCount: z.number().int().nonnegative().optional(),
        maxCount: z.number().int().nonnegative().optional(),
        reasons: z.array(z.string().min(1)).optional(),
        places: z.array(z.string().min(1)).optional(),
        kinds: z.array(z.string().min(1)).optional(),
        statuses: z.array(z.string().min(1)).optional(),
        held: z.number().int().nonnegative().optional(),
        reverted: z.number().int().nonnegative().optional(),
        startOffsets: z.array(z.number().nonnegative()).optional()
      })
      .strict()
      .optional(),
    connector: z
      .object({
        groupMessages: z.number().int().nonnegative().optional(),
        minGroupMessages: z.number().int().nonnegative().optional(),
        privateMessages: z.number().int().nonnegative().optional(),
        reactions: z.number().int().nonnegative().optional(),
        stickers: z.number().int().nonnegative().optional(),
        textsInclude: z.array(z.string().min(1)).optional(),
        textsExclude: z.array(z.string().min(1)).optional(),
        groupIds: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    modelInput: z
      .object({
        requests: z.number().int().nonnegative().optional(),
        minRequests: z.number().int().nonnegative().optional(),
        contains: z.array(z.string().min(1)).optional(),
        doesNotContain: z.array(z.string().min(1)).optional(),
        tools: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    toolOutputs: z
      .object({
        contain: z.array(z.string().min(1)).optional(),
        doNotContain: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    life: z
      .object({
        minCommits: z.number().int().nonnegative().optional(),
        commits: z.number().int().nonnegative().optional(),
        fileContains: z.array(FileExpectationSchema).optional(),
        fileDoesNotContain: z.array(FileExpectationSchema).optional()
      })
      .strict()
      .optional(),
    rollout: z
      .object({
        rollouts: z.number().int().nonnegative().optional(),
        conversationKeys: z.array(z.string().min(1)).optional(),
        recordTypes: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    session: z
      .object({
        selfMessages: z.number().int().nonnegative().optional(),
        turns: z.number().int().nonnegative().optional(),
        windows: z.number().int().nonnegative().optional(),
        wakeRecords: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const ScenarioFixtureSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    start: z.string().datetime(),
    /** Seconds of life to simulate after the last event is delivered. */
    until: z.number().positive(),
    homeFixture: z.string().min(1).optional(),
    configOverrides: z.string().optional(),
    /** A life directory copied into the home before the first boot. */
    lifeFixture: z.string().min(1).optional(),
    /** Restart the whole runtime at these offsets. */
    restarts: z.array(z.number().positive()).default([]),
    model: ScenarioModelSchema,
    events: z.array(ScenarioMessageSchema).default([]),
    expectations: ScenarioExpectationsSchema.default({})
  })
  .strict();

export type ScenarioFixture = z.infer<typeof ScenarioFixtureSchema>;
export type ScenarioMessage = z.infer<typeof ScenarioMessageSchema>;
