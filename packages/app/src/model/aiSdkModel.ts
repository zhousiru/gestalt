import { createHash, randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet
} from "ai";
import { z } from "zod";
import type { GestaltConfig } from "../home/loadConfig";
import { sanitizeUntrustedValue } from "../privacy/stickerRedaction";
import {
  ACTION_TOOL_PROMPTS,
  hashModelToolPrompts,
  renderActionToolDescription,
  type PromptMetadata
} from "../prompts";
import type { ToolDefinition } from "../tools/schemas";
import {
  attachModelStepsToError,
  readUsageTotals,
  type CreateModelSessionOptions,
  type ImageAttachment,
  type ModelClient,
  type ModelExchangeSink,
  type ModelRequestTraceSnapshot,
  type ModelResponseTraceSnapshot,
  type ModelSession,
  type ModelStepTraceSnapshot,
  type ModelUsageTotals
} from "./session";
import {
  readLanguageMaxSteps,
  readLanguagePromptCacheEnabled,
  readLanguagePromptCacheTtl,
  readLanguageTemperature,
  readLanguageToolChoice,
  resolveLanguageModelConfig,
  type LanguageModelRole,
  type ModelProviderOptions,
  type ModelToolChoiceMode,
  type ResolvedLanguageModelConfig
} from "./modelConfig";

export {
  resolveEmbeddingModelConfig,
  resolveLanguageModelConfig,
  resolveMainModelConfig,
  resolveSubModelConfig
} from "./modelConfig";
export type {
  LanguageModelRole,
  ModelJsonValue,
  ModelProviderOptions,
  ModelToolChoiceMode,
  ResolvedEmbeddingModelConfig,
  ResolvedLanguageModelConfig
} from "./modelConfig";

export interface ModelMessageSnapshot {
  role: string;
  content: unknown;
}

export interface ModelToolProtocolSnapshot {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ModelToolCallSnapshot {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResultSnapshot {
  id: string;
  name: string;
  output?: unknown;
  error?: unknown;
}

export interface ModelRequestSnapshot {
  provider: string;
  model: string;
  temperature: number;
  stepNumber: number;
  messages: ModelMessageSnapshot[];
  tools: string[];
  toolProtocol?: ModelToolProtocolSnapshot[];
  toolChoice?: unknown;
  requestBody?: unknown;
  sessionId?: string;
  promptCacheEnabled?: boolean;
  prompt?: PromptMetadata;
}

export interface ModelResponseSnapshot {
  content?: string;
  finishReason?: string;
  stepNumber?: number;
  toolCalls?: ModelToolCallSnapshot[];
  toolResults?: ModelToolResultSnapshot[];
  usage?: unknown;
  cacheUsage?: ModelCacheUsageSnapshot;
  requestBody?: unknown;
  responseBody?: unknown;
}

export interface ModelCacheUsageSnapshot {
  readTokens: number;
  writeTokens?: number;
}

export interface ResolvedAiSdkLanguageModel
  extends ResolvedLanguageModelConfig {
  languageModel: LanguageModel;
}

export interface CreateAiSdkModelOptions {
  languageModel: LanguageModel;
  modelName: string;
  providerName?: string;
  providerOptions?: ModelProviderOptions;
  toolChoice?: ModelToolChoiceMode;
  temperature?: number;
  timeoutMs?: number;
  maxSteps?: number;
  promptCacheEnabled?: boolean;
  promptCacheTtl?: "5m" | "1h";
  now?: () => Date;
  onRequest?: (request: ModelRequestSnapshot) => void;
  onResponse?: (response: ModelResponseSnapshot) => void;
}

export interface CreateAiSdkModelFromConfigOptions
  extends Omit<CreateAiSdkModelOptions, "languageModel" | "modelName"> {
  role?: LanguageModelRole;
  apiKeyEnvOverride?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export function createAiSdkModel(options: CreateAiSdkModelOptions): ModelClient {
  const now = options.now ?? (() => new Date());
  const temperature = options.temperature ?? 1;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxSteps = options.maxSteps ?? 1000;
  const providerName = options.providerName ?? "openai-compatible";
  const toolChoice = options.toolChoice;

  return {
    name: options.modelName,
    createSession(sessionOptions: CreateModelSessionOptions = {}) {
      return createAiSdkModelSession({
        options,
        ...(sessionOptions.exchangeSink
          ? { exchangeSink: sessionOptions.exchangeSink }
          : {}),
        now,
        temperature,
        timeoutMs,
        maxSteps,
        providerName,
        toolChoice
      });
    }
  };
}

interface AiSdkModelSessionOptions {
  options: CreateAiSdkModelOptions;
  now: () => Date;
  temperature: number;
  timeoutMs: number;
  maxSteps: number;
  providerName: string;
  toolChoice: ModelToolChoiceMode | undefined;
  exchangeSink?: ModelExchangeSink;
}

function createAiSdkModelSession(
  sessionOptions: AiSdkModelSessionOptions
): ModelSession {
  const {
    options,
    now,
    temperature,
    timeoutMs,
    maxSteps,
    providerName,
    toolChoice,
    exchangeSink
  } = sessionOptions;

  return {
    async run(input) {
      const providerOptions = createModelSessionProviderOptions(
        options.providerOptions,
        providerName,
        input.providerSessionId,
        options.promptCacheEnabled ?? false,
        options.promptCacheTtl
      );
      const stepRecorder = createModelStepRecorder(now);
      const pendingExchanges: Array<{
        exchangeId: string;
        request: ModelRequestSnapshot;
        startedAt: string;
      }> = [];
      const pendingImages: ImageAttachment[] = [];
      const usage: ModelUsageTotals = {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0
      };
      let stopRequested = false;
      let toolTail: Promise<unknown> = Promise.resolve();

      // Models may emit several tool calls in one step. A life happens in order,
      // so they run one after another, and nothing runs after sleep.
      const execute = (
        toolName: ToolDefinition["name"],
        args: Record<string, unknown>
      ): Promise<unknown> => {
        const result = toolTail.then(async () => {
          if (stopRequested) {
            return { status: "skipped", reason: "You are already asleep." };
          }
          const outcome = await input.execute(toolName, args);
          if (outcome.images) {
            pendingImages.push(...outcome.images);
          }
          if (outcome.stop) {
            stopRequested = true;
          }
          return outcome.output;
        });
        toolTail = result.catch(() => undefined);
        return result;
      };

      const prompt: PromptMetadata = {
        id: input.instructions.id,
        contentHash: input.instructions.contentHash,
        toolPromptHash: hashModelToolPrompts(
          input.tools.map((candidate) => candidate.name)
        )
      };
      const agent = new ToolLoopAgent({
        id: "gestalt-wake",
        model: options.languageModel,
        instructions: input.instructions.content,
        tools: buildLifeTools(input.tools, execute),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        toolOrder: input.tools.map((candidate) => candidate.name),
        ...(providerOptions ? { providerOptions } : {}),
        stopWhen: [
          () => stopRequested,
          stepCountIs(Math.min(input.maxSteps, maxSteps))
        ],
        temperature,
        prepareStep({ messages: stepMessages }) {
          if (pendingImages.length === 0) {
            return undefined;
          }
          const images = pendingImages.splice(0, pendingImages.length);
          return {
            messages: [
              ...stepMessages,
              {
                role: "user",
                content: images.flatMap((image) => [
                  { type: "text" as const, text: image.label },
                  {
                    type: "file" as const,
                    data: image.data,
                    mediaType: image.mediaType
                  }
                ])
              }
            ]
          };
        },
        include: {
          requestBody: true,
          requestMessages: true,
          responseBody: true
        },
        async onStepStart(event) {
          const request = snapshotStepRequest(event, {
            providerName,
            modelName: options.modelName,
            temperature,
            sessionId: input.providerSessionId,
            promptCacheEnabled: options.promptCacheEnabled ?? false,
            prompt
          });
          const exchangeId = randomUUID();
          const startedAt = now().toISOString();
          stepRecorder.recordRequest(request);
          pendingExchanges.push({ exchangeId, request, startedAt });
          await exchangeSink?.onStepStarted({
            exchangeId,
            purpose: input.purpose(),
            request,
            startedAt
          });
          options.onRequest?.(request);
        },
        async onStepEnd(step) {
          const response = snapshotStepResponse({
            ...step,
            responseMessages: step.response.messages
          });
          stepRecorder.recordResponse(response);
          const stepUsage = readUsageTotals(response.usage);
          usage.inputTokens += stepUsage.inputTokens;
          usage.outputTokens += stepUsage.outputTokens;
          usage.cachedTokens += stepUsage.cachedTokens;
          const exchange = pendingExchanges.shift();
          if (exchange) {
            await exchangeSink?.onStepCompleted({
              exchangeId: exchange.exchangeId,
              purpose: input.purpose(),
              request: exchange.request,
              response,
              status: "completed",
              startedAt: exchange.startedAt,
              endedAt: now().toISOString()
            });
          }
          options.onResponse?.(response);
        }
      });

      const generate = (messages: ModelMessage[]) =>
        agent.generate({
          messages,
          timeout: { totalMs: timeoutMs },
          ...(input.signal ? { abortSignal: input.signal } : {})
        });
      try {
        const opening: ModelMessage = {
          role: "user",
          content: input.opening.content
        };
        const first = await generate([opening]);
        if (!stopRequested && first.steps.length < input.maxSteps) {
          // Not every provider accepts a required tool choice, and a model that
          // simply stops has not decided anything. It gets one chance to.
          await generate([
            opening,
            ...first.steps
              .flatMap((step) => step.response.messages)
              .filter(hasContent),
            { role: "user", content: input.unfinished.content }
          ]);
        }
      } catch (error) {
        const endedAt = now().toISOString();
        for (const exchange of pendingExchanges.splice(0)) {
          await exchangeSink?.onStepCompleted({
            exchangeId: exchange.exchangeId,
            purpose: input.purpose(),
            request: exchange.request,
            status: input.signal?.aborted ? "cancelled" : "failed",
            startedAt: exchange.startedAt,
            endedAt
          });
        }
        attachModelStepsToError(error, stepRecorder.steps);
        throw error;
      }
      return { steps: stepRecorder.steps, usage };
    }
  };
}

function hasContent(message: ModelMessage): boolean {
  return message.content.length > 0;
}

export function createModelStepRecorder(now: () => Date = () => new Date()): {
  readonly steps: ModelStepTraceSnapshot[];
  recordRequest(request: ModelRequestSnapshot): void;
  recordResponse(response: ModelResponseSnapshot): void;
} {
  const steps: ModelStepTraceSnapshot[] = [];

  return {
    steps,

    recordRequest(request) {
      steps.push({
        startedAt: now().toISOString(),
        request: compactModelRequestTrace(request)
      });
    },

    recordResponse(response) {
      const existing =
        findLastStep(steps,
          (candidate) =>
            candidate.request?.stepNumber === response.stepNumber &&
            candidate.response === undefined
        ) ??
        findLastStep(steps,
          (candidate) =>
            candidate.request === undefined &&
            candidate.response?.stepNumber === response.stepNumber
        );
      if (existing) {
        existing.response = compactModelResponseTrace(response);
        existing.endedAt = now().toISOString();
        return;
      }
      steps.push({
        endedAt: now().toISOString(),
        response: compactModelResponseTrace(response)
      });
    }
  };
}

function compactModelRequestTrace(
  request: ModelRequestSnapshot
): ModelRequestTraceSnapshot {
  const serializedMessages = JSON.stringify(request.messages);
  return {
    provider: request.provider,
    model: request.model,
    temperature: request.temperature,
    stepNumber: request.stepNumber,
    messageCount: request.messages.length,
    messagesHash: createHash("sha256")
      .update(serializedMessages)
      .digest("hex"),
    tools: request.tools,
    ...(request.toolChoice !== undefined
      ? { toolChoice: sanitizeUntrustedValue(request.toolChoice) }
      : {}),
    ...(request.prompt ? { prompt: request.prompt } : {})
  };
}

function compactModelResponseTrace(
  response: ModelResponseSnapshot
): ModelResponseTraceSnapshot {
  const toolCalls = sanitizeUntrustedValue(response.toolCalls ?? []);
  const toolResults = sanitizeUntrustedValue(response.toolResults ?? []);
  return {
    ...(response.content
      ? {
          content:
            response.content.length <= 500
              ? response.content
              : `${response.content.slice(0, 500)}...`
        }
      : {}),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.stepNumber !== undefined
      ? { stepNumber: response.stepNumber }
      : {}),
    ...(Array.isArray(toolCalls) ? { toolCalls } : {}),
    ...(Array.isArray(toolResults) ? { toolResults } : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    ...(response.cacheUsage ? { cacheUsage: response.cacheUsage } : {})
  };
}

function findLastStep(
  steps: ModelStepTraceSnapshot[],
  predicate: (step: ModelStepTraceSnapshot) => boolean
): ModelStepTraceSnapshot | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && predicate(step)) {
      return step;
    }
  }
  return undefined;
}

export function createAiSdkModelFromConfig(
  config: GestaltConfig,
  options: CreateAiSdkModelFromConfigOptions = {}
): ModelClient {
  const {
    role = "main",
    apiKeyEnvOverride,
    fetch,
    headers,
    ...modelOptions
  } = options;
  const resolved = createLanguageModelFromConfig(config, {
    role,
    ...(apiKeyEnvOverride ? { apiKeyEnvOverride } : {}),
    ...(fetch ? { fetch } : {}),
    ...(headers ? { headers } : {})
  });
  const temperature = modelOptions.temperature ?? resolved.temperature;
  return createAiSdkModel({
    ...modelOptions,
    languageModel: resolved.languageModel,
    modelName: resolved.modelName,
    providerName: resolved.providerName,
    maxSteps: resolved.maxSteps,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(resolved.toolChoice !== undefined
      ? { toolChoice: resolved.toolChoice }
      : {}),
    ...(resolved.providerOptions
      ? { providerOptions: resolved.providerOptions }
      : {}),
    ...(resolved.promptCacheEnabled !== undefined
      ? { promptCacheEnabled: resolved.promptCacheEnabled }
      : {}),
    ...(resolved.promptCacheTtl
      ? { promptCacheTtl: resolved.promptCacheTtl }
      : {})
  });
}

export function createLanguageModelFromConfig(
  config: GestaltConfig,
  options: {
    role?: LanguageModelRole;
    apiKeyEnvOverride?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    supportsStructuredOutputs?: boolean;
  } = {}
): ResolvedAiSdkLanguageModel {
  const resolved = resolveLanguageModelConfig(
    config,
    options.role ?? "main"
  );
  const apiKeyEnv = options.apiKeyEnvOverride ?? resolved.apiKeyEnv;
  const apiKey = options.apiKeyEnvOverride
    ? process.env[options.apiKeyEnvOverride]
    : resolved.apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
  if (!apiKey) {
    throw new Error(
      apiKeyEnv ? `Missing ${apiKeyEnv}.` : "Missing language model API key."
    );
  }
  const provider = createOpenAICompatible({
    name: resolved.providerName,
    baseURL: resolved.baseUrl,
    apiKey,
    ...(options.supportsStructuredOutputs !== undefined
      ? { supportsStructuredOutputs: options.supportsStructuredOutputs }
      : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });

  return {
    ...resolved,
    languageModel: provider.chatModel(resolved.modelName),
    ...(apiKeyEnv ? { apiKeyEnv } : {})
  };
}

export function readModelPromptCacheEnabled(
  config: GestaltConfig,
  providerName?: string
): boolean {
  return readLanguagePromptCacheEnabled(config, "main", providerName);
}

export function readModelPromptCacheTtl(
  config: GestaltConfig
): "5m" | "1h" | undefined {
  return readLanguagePromptCacheTtl(config, "main");
}

export function readModelToolChoice(
  config: GestaltConfig
): ModelToolChoiceMode | undefined {
  return readLanguageToolChoice(config, "main");
}

export function readModelMaxSteps(config: GestaltConfig): number {
  return readLanguageMaxSteps(config, "main");
}

export function readModelTemperature(config: GestaltConfig): number | undefined {
  return readLanguageTemperature(config, "main");
}

export function optionalProviderOptions(
  config: GestaltConfig,
  providerName: string
): { providerOptions: ModelProviderOptions } | {} {
  const resolved = resolveLanguageModelConfig(config, "main");
  const providerOptions = resolved.providerOptions;
  if (!providerOptions) {
    return {};
  }

  return {
    providerOptions:
      providerName === resolved.providerName
        ? providerOptions
        : { [providerName]: Object.values(providerOptions)[0] ?? {} }
  };
}

export function createModelSessionProviderOptions(
  base: ModelProviderOptions | undefined,
  providerName: string,
  sessionId: string,
  promptCacheEnabled: boolean,
  promptCacheTtl: "5m" | "1h" | undefined
): ModelProviderOptions | undefined {
  if (!promptCacheEnabled) {
    return base;
  }
  const provider = { ...(base?.[providerName] ?? {}) };
  provider.session_id = sessionId;
  provider.cache_control = {
    type: "ephemeral",
    ...(promptCacheTtl === "1h" ? { ttl: "1h" } : {})
  };
  return {
    ...(base ?? {}),
    [providerName]: provider
  };
}

export function snapshotStepRequest(
  event: {
    provider?: string | undefined;
    modelId?: string | undefined;
    stepNumber?: number | undefined;
    messages?: readonly unknown[] | undefined;
    instructions?: unknown;
    tools?: ToolSet | undefined;
    toolChoice?: unknown;
  },
  fallback: {
    providerName: string;
    modelName: string;
    temperature: number;
    sessionId?: string;
    promptCacheEnabled?: boolean;
    prompt?: PromptMetadata;
  }
): ModelRequestSnapshot {
  return {
    provider: event.provider ?? fallback.providerName,
    model: event.modelId ?? fallback.modelName,
    temperature: fallback.temperature,
    stepNumber: event.stepNumber ?? 0,
    messages: snapshotMessages(event.messages ?? [], event.instructions),
    tools: event.tools ? Object.keys(event.tools) : [],
    ...(event.tools ? { toolProtocol: snapshotToolProtocol(event.tools) } : {}),
    ...(event.toolChoice !== undefined ? { toolChoice: event.toolChoice } : {}),
    ...(fallback.sessionId ? { sessionId: fallback.sessionId } : {}),
    ...(fallback.promptCacheEnabled !== undefined
      ? { promptCacheEnabled: fallback.promptCacheEnabled }
      : {}),
    ...(fallback.prompt ? { prompt: fallback.prompt } : {})
  };
}

export function snapshotStepResponse(step: {
  stepNumber?: number;
  text?: string;
  finishReason?: string;
  toolCalls?: readonly unknown[];
  toolResults?: readonly unknown[];
  usage?: unknown;
  request?: unknown;
  response?: unknown;
  responseMessages?: readonly unknown[];
}): ModelResponseSnapshot {
  const requestBody = readUnknownProperty(step.request, "body");
  const responseBody = readUnknownProperty(step.response, "body");
  const cacheUsage = mergeCacheUsage(
    readCacheUsage(step.usage),
    readProviderCacheUsage(responseBody)
  );
  const messageToolCalls = snapshotToolCallsFromMessages(
    step.responseMessages ?? []
  );
  const messageToolResults = snapshotToolResultsFromMessages(
    step.responseMessages ?? []
  );
  const response: ModelResponseSnapshot = {
    ...(step.text ? { content: step.text } : {}),
    ...(step.finishReason ? { finishReason: step.finishReason } : {}),
    ...(step.stepNumber !== undefined ? { stepNumber: step.stepNumber } : {}),
    toolCalls:
      step.toolCalls && step.toolCalls.length > 0
        ? snapshotToolCalls(step.toolCalls)
        : messageToolCalls,
    toolResults:
      step.toolResults && step.toolResults.length > 0
        ? snapshotToolResults(step.toolResults)
        : messageToolResults,
    ...(step.responseMessages
      ? { messages: snapshotMessages(step.responseMessages) }
      : {}),
    ...(step.usage !== undefined ? { usage: step.usage } : {}),
    ...(cacheUsage ? { cacheUsage } : {})
  };
  if (requestBody !== undefined) {
    response.requestBody = requestBody;
  }
  if (responseBody !== undefined) {
    response.responseBody = responseBody;
  }
  return response;
}

function readProviderCacheUsage(
  responseBody: unknown
): ModelCacheUsageSnapshot | undefined {
  const body = parseJsonObject(responseBody);
  const usage = readUnknownProperty(body, "usage");
  const promptDetails = readUnknownProperty(usage, "prompt_tokens_details");
  const readTokens = readOptionalNumber(promptDetails, "cached_tokens");
  const writeTokens = readOptionalNumber(promptDetails, "cache_write_tokens");
  if (readTokens === undefined && writeTokens === undefined) {
    return undefined;
  }
  return {
    readTokens: readTokens ?? 0,
    ...(writeTokens !== undefined ? { writeTokens } : {})
  };
}

function mergeCacheUsage(
  normalized: ModelCacheUsageSnapshot | undefined,
  provider: ModelCacheUsageSnapshot | undefined
): ModelCacheUsageSnapshot | undefined {
  if (!normalized && !provider) {
    return undefined;
  }
  return {
    readTokens: provider?.readTokens ?? normalized?.readTokens ?? 0,
    ...(provider?.writeTokens !== undefined
      ? { writeTokens: provider.writeTokens }
      : normalized?.writeTokens !== undefined
        ? { writeTokens: normalized.writeTokens }
        : {})
  };
}

function readCacheUsage(usage: unknown): ModelCacheUsageSnapshot | undefined {
  const inputDetails = readUnknownProperty(usage, "inputTokenDetails");
  const raw = readUnknownProperty(usage, "raw");
  const promptDetails = readUnknownProperty(raw, "prompt_tokens_details");
  const readTokens =
    readOptionalNumber(inputDetails, "cacheReadTokens") ??
    readOptionalNumber(promptDetails, "cached_tokens");
  const writeTokens =
    readOptionalNumber(inputDetails, "cacheWriteTokens") ??
    readOptionalNumber(promptDetails, "cache_write_tokens");
  if (readTokens === undefined && writeTokens === undefined) {
    return undefined;
  }
  return {
    readTokens: readTokens ?? 0,
    ...(writeTokens !== undefined ? { writeTokens } : {})
  };
}

export function buildLifeTools(
  definitions: readonly ToolDefinition[],
  execute?: (
    toolName: ToolDefinition["name"],
    args: Record<string, unknown>
  ) => Promise<unknown>
): ToolSet {
  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = tool({
      description: renderActionToolDescription(definition.name),
      inputSchema: toolInputSchema(definition.name) as z.ZodType<
        Record<string, unknown>
      >,
      async execute(input: Record<string, unknown>) {
        if (!execute) {
          return { status: "unavailable" };
        }
        return execute(definition.name, input);
      }
    }) as unknown as ToolSet[string];
  }
  return tools;
}

function toolInputSchema(name: ToolDefinition["name"]) {
  const parameter = (key: string): string => toolParameterPrompt(name, key);
  switch (name) {
    case "look":
      return z
        .object({
          place: z.string().min(1).optional().describe(parameter("place")),
          before: z.string().min(1).optional().describe(parameter("before")),
          search: z.string().min(1).optional().describe(parameter("search")),
          message_id: z
            .string()
            .min(1)
            .optional()
            .describe(parameter("message_id")),
          image: z.string().min(1).optional().describe(parameter("image"))
        })
        .strict();
    case "say":
      return z
        .object({
          text: z.string().min(1).optional().describe(parameter("text")),
          sticker_id: z
            .string()
            .min(1)
            .optional()
            .describe(parameter("sticker_id")),
          reply_to: z.string().min(1).optional().describe(parameter("reply_to"))
        })
        .strict();
    case "react":
      return z
        .object({
          message_id: z.string().min(1).describe(parameter("message_id")),
          emoji: z.string().min(1).describe(parameter("emoji"))
        })
        .strict();
    case "sleep":
      return z
        .object({
          seconds: z.number().nonnegative().describe(parameter("seconds")),
          note: z.string().min(1).optional().describe(parameter("note")),
          do_not_disturb: z
            .boolean()
            .optional()
            .describe(parameter("do_not_disturb"))
        })
        .strict();
    case "bash":
      return z
        .object({
          command: z.string().min(1).describe(parameter("command"))
        })
        .strict();
  }
}

function toolParameterPrompt(
  toolName: ToolDefinition["name"],
  parameter: string
): string {
  const parameters: Readonly<Record<string, string>> =
    ACTION_TOOL_PROMPTS[toolName].parameters;
  const description = parameters[parameter];
  if (!description) {
    throw new Error(
      `Missing prompt for tool parameter ${toolName}.${parameter}.`
    );
  }
  return description;
}

function snapshotMessages(
  messages: readonly unknown[],
  instructions?: unknown
): ModelMessageSnapshot[] {
  const snapshots: ModelMessageSnapshot[] = [];
  if (instructions !== undefined) {
    snapshots.push({
      role: "system",
      content: snapshotMessageContent(instructions)
    });
  }
  for (const message of messages) {
    snapshots.push(snapshotMessage(message));
  }
  return snapshots;
}

function snapshotMessage(message: unknown): ModelMessageSnapshot {
  if (message && typeof message === "object") {
    const role = readUnknownProperty(message, "role");
    const content = readUnknownProperty(message, "content");
    return {
      role: typeof role === "string" ? role : "unknown",
      content: snapshotMessageContent(content)
    };
  }
  return {
    role: "unknown",
    content: snapshotMessageContent(message)
  };
}

function snapshotToolCalls(
  toolCalls: readonly unknown[]
): ModelToolCallSnapshot[] {
  return toolCalls.map((toolCall) => readToolCall(toolCall));
}

function snapshotToolResults(
  toolResults: readonly unknown[]
): ModelToolResultSnapshot[] {
  return toolResults.map((toolResult, index) => {
    const id = readUnknownProperty(toolResult, "toolCallId");
    const name = readUnknownProperty(toolResult, "toolName");
    const output = readUnknownProperty(toolResult, "output");
    const error = readUnknownProperty(toolResult, "error");
    return {
      id: typeof id === "string" ? id : `tool-result-${index}`,
      name: typeof name === "string" ? name : "unknown",
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {})
    };
  });
}

function snapshotToolCallsFromMessages(
  messages: readonly unknown[]
): ModelToolCallSnapshot[] {
  return messageParts(messages)
    .filter((part) => readUnknownProperty(part, "type") === "tool-call")
    .map(readToolCall);
}

function snapshotToolResultsFromMessages(
  messages: readonly unknown[]
): ModelToolResultSnapshot[] {
  return messageParts(messages)
    .filter((part) => readUnknownProperty(part, "type") === "tool-result")
    .map((part, index) => {
      const id = readUnknownProperty(part, "toolCallId");
      const name = readUnknownProperty(part, "toolName");
      const output = readUnknownProperty(part, "output");
      return {
        id: typeof id === "string" ? id : `tool-result-${index}`,
        name: typeof name === "string" ? name : "unknown",
        ...(output !== undefined ? { output } : {})
      };
    });
}

function messageParts(messages: readonly unknown[]): unknown[] {
  return messages.flatMap((message) => {
    const content = readUnknownProperty(message, "content");
    return Array.isArray(content) ? content : [];
  });
}

function readToolCall(toolCall: unknown): ModelToolCallSnapshot {
  const id = readUnknownProperty(toolCall, "toolCallId");
  const name = readUnknownProperty(toolCall, "toolName");
  return {
    id: typeof id === "string" ? id : "unknown-tool-call",
    name: typeof name === "string" ? name : "unknown",
    input: readUnknownProperty(toolCall, "input") ?? {}
  };
}

function snapshotMessageContent(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return prepareStructuredContentForJson(
      value,
      undefined,
      undefined,
      new WeakSet<object>()
    );
  } catch {
    return String(value);
  }
}

function snapshotToolProtocol(tools: ToolSet): ModelToolProtocolSnapshot[] {
  return Object.entries(tools).map(([name, definition]) => {
    const description = readUnknownProperty(definition, "description");
    const inputSchema = readUnknownProperty(definition, "inputSchema");
    const jsonSchema = snapshotJsonSchema(inputSchema);
    return {
      name,
      ...(typeof description === "string" ? { description } : {}),
      ...(jsonSchema !== undefined ? { inputSchema: jsonSchema } : {})
    };
  });
}

function snapshotJsonSchema(value: unknown): unknown {
  const toJSONSchema = readUnknownProperty(value, "toJSONSchema");
  if (typeof toJSONSchema !== "function") {
    return undefined;
  }
  try {
    return toJSONSchema.call(value);
  } catch {
    return undefined;
  }
}

const SNAPSHOT_BINARY_PAYLOAD_KEYS = new Set([
  "base64",
  "body",
  "buffer",
  "bytearray",
  "bytes",
  "content",
  "data",
  "image",
  "audio",
  "video",
  "media",
  "payload",
  "source"
]);

/**
 * Provider message content can contain Buffers and typed arrays. Encoding them
 * with ordinary JSON.stringify expands them into numeric properties before the
 * rollout boundary gets a chance to externalize them. Preserve the full bytes
 * for the harness and optional blob capture, but carry them as explicit base64
 * source objects so no intermediate JSON contains a numeric byte dump.
 */
function prepareStructuredContentForJson(
  value: unknown,
  mediaTypeHint: string | undefined,
  fieldName: string | undefined,
  ancestors: WeakSet<object>,
  depth = 0
): unknown {
  if (depth > 100) {
    return "[MaxDepth]";
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "string") {
    const decoded = decodeSnapshotBinary(value, mediaTypeHint, fieldName);
    return decoded
      ? encodeSnapshotBinary(decoded.bytes, decoded.mediaType)
      : value;
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const bytes = snapshotBytesFromValue(value, mediaTypeHint, fieldName);
  if (bytes) {
    return encodeSnapshotBinary(
      bytes,
      mediaTypeHint ?? "application/octet-stream"
    );
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) =>
        prepareStructuredContentForJson(
          item,
          mediaTypeHint,
          undefined,
          ancestors,
          depth + 1
        )
      );
    }
    const record = value as Record<string, unknown>;
    const objectMediaType =
      readSnapshotMediaType(record) ?? mediaTypeHint;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      output[key] = prepareStructuredContentForJson(
        item,
        objectMediaType,
        key,
        ancestors,
        depth + 1
      );
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotBytesFromValue(
  value: object,
  mediaTypeHint?: string,
  fieldName?: string
): Uint8Array | undefined {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    mediaTypeHint &&
    isSnapshotBinaryPayloadKey(fieldName) &&
    Array.isArray(value) &&
    isSnapshotByteArray(value)
  ) {
    return Uint8Array.from(value);
  }
  const record = value as Record<string, unknown>;
  if (
    ["Buffer", "Uint8Array", "ArrayBuffer"].includes(String(record.type)) &&
    Array.isArray(record.data) &&
    isSnapshotByteArray(record.data)
  ) {
    return Uint8Array.from(record.data);
  }
  return undefined;
}

function encodeSnapshotBinary(
  bytes: Uint8Array,
  mediaType: string
): Record<string, unknown> {
  const stable = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: "binary_source",
    mediaType,
    byteLength: stable.byteLength,
    sha256: createHash("sha256").update(stable).digest("hex"),
    base64: stable.toString("base64")
  };
}

function decodeSnapshotBinary(
  value: string,
  mediaTypeHint?: string,
  fieldName?: string
): { bytes: Uint8Array; mediaType: string } | undefined {
  const trimmed = value.trim();
  const dataUri = trimmed.match(
    /^data:([^;,\s]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i
  );
  const oneBot = trimmed.match(/^base64:\/\/([a-z0-9+/=\s]+)$/i);
  const bare =
    mediaTypeHint &&
    !mediaTypeHint.toLowerCase().startsWith("text/") &&
    isSnapshotBinaryPayloadKey(fieldName)
      ? trimmed
      : undefined;
  const encoded = (dataUri?.[2] ?? oneBot?.[1] ?? bare)?.replace(/\s+/g, "");
  if (
    !encoded ||
    (bare !== undefined && !encoded.includes("=") && encoded.length < 16) ||
    !isSnapshotBase64(encoded)
  ) {
    return undefined;
  }
  return {
    bytes: Buffer.from(encoded, "base64"),
    mediaType:
      dataUri?.[1]?.toLowerCase() ??
      mediaTypeHint ??
      "application/octet-stream"
  };
}

function readSnapshotMediaType(
  value: Record<string, unknown>
): string | undefined {
  for (const key of ["mediaType", "mimeType", "contentType", "mime_type"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string" &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
        candidate.trim()
      )
    ) {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

function isSnapshotBinaryPayloadKey(value: string | undefined): boolean {
  return value
    ? SNAPSHOT_BINARY_PAYLOAD_KEYS.has(
        value.replace(/[_-]/g, "").toLowerCase()
      )
    : false;
}

function isSnapshotByteArray(value: readonly unknown[]): value is number[] {
  return value.every(
    (item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255
  );
}

function isSnapshotBase64(value: string): boolean {
  if (!value || value.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    return false;
  }
  const unpadded = value.replace(/=+$/, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  return (
    Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "") ===
    unpadded
  );
}

function readUnknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readOptionalNumber(value: unknown, key: string): number | undefined {
  const candidate = readUnknownProperty(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (!source) {
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
