import { randomUUID } from "node:crypto";
import type { PromptMetadata, RenderedPrompt } from "../prompts/types";
import { hashModelToolPrompts } from "../prompts/tools";
import type { ToolDefinition, ToolName } from "../tools/schemas";

export interface ModelClient {
  name?: string;
  createSession(options?: CreateModelSessionOptions): ModelSession;
}

export type ModelExchangePurpose = "agent_action" | "dreaming";

export interface ModelExchangeStartedSnapshot {
  exchangeId: string;
  purpose: ModelExchangePurpose;
  request: ModelRequestTraceSnapshot;
  startedAt?: string;
}

export interface ModelExchangeSnapshot extends ModelExchangeStartedSnapshot {
  response?: ModelResponseTraceSnapshot;
  status: "completed" | "failed" | "cancelled";
  endedAt?: string;
}

export interface ModelExchangeSink {
  onStepStarted(exchange: ModelExchangeStartedSnapshot): void | Promise<void>;
  onStepCompleted(exchange: ModelExchangeSnapshot): void | Promise<void>;
  flush?(): Promise<void>;
}

export interface CreateModelSessionOptions {
  exchangeSink?: ModelExchangeSink;
}

export interface ImageAttachment {
  label: string;
  data: Uint8Array;
  mediaType: string;
}

/** What a tool call returned, and what that means for the wake. */
export interface ToolOutcome {
  output: unknown;
  images?: ImageAttachment[];
  /** The wake is over. No further tool call runs. */
  stop?: boolean;
}

export type ToolExecutor = (
  toolName: ToolName,
  input: Record<string, unknown>
) => Promise<ToolOutcome>;

export interface ModelRunInput {
  instructions: RenderedPrompt;
  opening: RenderedPrompt;
  tools: readonly ToolDefinition[];
  execute: ToolExecutor;
  maxSteps: number;
  purpose(): ModelExchangePurpose;
  providerSessionId: string;
  signal?: AbortSignal;
}

export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ModelRunResult {
  steps: ModelStepTraceSnapshot[];
  usage: ModelUsageTotals;
}

/**
 * One model conversation for one wake. A session runs once: the wake's context
 * is compiled up front and nothing is carried to the next wake except what the
 * home and the journal hold.
 */
export interface ModelSession {
  run(input: ModelRunInput): Promise<ModelRunResult>;
}

export interface ModelStepTraceSnapshot {
  startedAt?: string;
  endedAt?: string;
  request?: ModelRequestTraceSnapshot;
  response?: ModelResponseTraceSnapshot;
}

export interface ModelRequestTraceSnapshot {
  provider: string;
  model: string;
  temperature: number;
  stepNumber: number;
  messages?: unknown[];
  messageCount?: number;
  messagesHash?: string;
  tools: string[];
  toolProtocol?: unknown[];
  toolChoice?: unknown;
  requestBody?: unknown;
  prompt?: PromptMetadata;
  sessionId?: string;
  promptCacheEnabled?: boolean;
}

export interface ModelResponseTraceSnapshot {
  content?: string;
  messages?: unknown[];
  finishReason?: string;
  stepNumber?: number;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  usage?: unknown;
  cacheUsage?: {
    readTokens: number;
    writeTokens?: number;
  };
  requestBody?: unknown;
  responseBody?: unknown;
}

const modelStepsErrorKey = "__gestaltModelSteps";

export function attachModelStepsToError(
  error: unknown,
  modelSteps: ModelStepTraceSnapshot[]
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  (error as { [modelStepsErrorKey]?: ModelStepTraceSnapshot[] })[
    modelStepsErrorKey
  ] = modelSteps;
}

export function readModelStepsFromError(
  error: unknown
): ModelStepTraceSnapshot[] | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as { [modelStepsErrorKey]?: unknown })[modelStepsErrorKey];
  return Array.isArray(value) ? (value as ModelStepTraceSnapshot[]) : undefined;
}

export function readUsageTotals(usage: unknown): ModelUsageTotals {
  const record = (usage ?? {}) as Record<string, unknown>;
  const details = (record.inputTokenDetails ?? {}) as Record<string, unknown>;
  return {
    inputTokens: numberOrZero(record.inputTokens),
    outputTokens: numberOrZero(record.outputTokens),
    cachedTokens: numberOrZero(details.cacheReadTokens)
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface ScriptedToolCall {
  toolName: ToolName;
  input?: Record<string, unknown>;
  /** Text the model "thinks" alongside the call. */
  text?: string;
}

export interface ScriptedStepInput {
  wake: number;
  step: number;
  instructions: string;
  opening: string;
  lastOutput: unknown;
  outputs: readonly unknown[];
}

/** Returns undefined to end the wake without calling a tool. */
export type ModelScript = (
  input: ScriptedStepInput
) => ScriptedToolCall | undefined;

export interface CreateScriptedModelOptions {
  script: ModelScript;
  now?: () => Date;
  /** Tokens reported per generation, so budget mechanics can be proven. */
  usagePerStep?: { inputTokens: number; outputTokens: number };
}

/**
 * Deterministic stand-in used to prove runtime mechanics. It speaks the same
 * message shapes as the AI SDK so rollout reconstruction stays honest.
 */
export function createScriptedModel(
  options: CreateScriptedModelOptions
): ModelClient {
  const now = options.now ?? (() => new Date());
  let wake = 0;

  return {
    name: "scripted",
    createSession(sessionOptions = {}) {
      const exchangeSink = sessionOptions.exchangeSink;
      return {
        async run(input) {
          wake += 1;
          const usagePerStep = options.usagePerStep ?? {
            inputTokens: 100,
            outputTokens: 10
          };
          const messages: unknown[] = [
            { role: "system", content: input.instructions.content },
            { role: "user", content: input.opening.content }
          ];
          const steps: ModelStepTraceSnapshot[] = [];
          const usage: ModelUsageTotals = {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0
          };
          const outputs: unknown[] = [];
          for (let step = 0; step < input.maxSteps; step += 1) {
            const call = options.script({
              wake,
              step,
              instructions: input.instructions.content,
              opening: input.opening.content,
              lastOutput: outputs.at(-1),
              outputs
            });
            const exchangeId = randomUUID();
            const startedAt = now().toISOString();
            const request: ModelRequestTraceSnapshot = {
              provider: "scripted",
              model: "scripted",
              temperature: 0,
              stepNumber: step,
              messages: [...messages],
              tools: input.tools.map((tool) => tool.name),
              toolProtocol: [...input.tools],
              sessionId: input.providerSessionId,
              prompt: {
                id: input.instructions.id,
                contentHash: input.instructions.contentHash,
                toolPromptHash: hashModelToolPrompts(
                  input.tools.map((tool) => tool.name)
                )
              }
            };
            await exchangeSink?.onStepStarted({
              exchangeId,
              purpose: input.purpose(),
              request,
              startedAt
            });
            const stepUsage = {
              inputTokens: usagePerStep.inputTokens,
              outputTokens: usagePerStep.outputTokens,
              totalTokens: usagePerStep.inputTokens + usagePerStep.outputTokens
            };
            usage.inputTokens += stepUsage.inputTokens;
            usage.outputTokens += stepUsage.outputTokens;

            if (!call) {
              const assistant = { role: "assistant", content: "" };
              const response: ModelResponseTraceSnapshot = {
                messages: [assistant],
                finishReason: "stop",
                stepNumber: step,
                toolCalls: [],
                usage: stepUsage
              };
              await exchangeSink?.onStepCompleted({
                exchangeId,
                purpose: input.purpose(),
                request,
                response,
                status: "completed",
                startedAt,
                endedAt: now().toISOString()
              });
              steps.push({ startedAt, request, response });
              return { steps, usage };
            }

            const toolCallId = randomUUID();
            const callInput = call.input ?? {};
            const outcome = await input.execute(call.toolName, callInput);
            outputs.push(outcome.output);
            const assistant = {
              role: "assistant",
              content: [
                ...(call.text ? [{ type: "text", text: call.text }] : []),
                {
                  type: "tool-call",
                  toolCallId,
                  toolName: call.toolName,
                  input: callInput
                }
              ]
            };
            const toolMessage = {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId,
                  toolName: call.toolName,
                  output: { type: "json", value: outcome.output }
                }
              ]
            };
            const response: ModelResponseTraceSnapshot = {
              messages: [assistant, toolMessage],
              finishReason: "tool-calls",
              stepNumber: step,
              toolCalls: [
                { id: toolCallId, name: call.toolName, input: callInput }
              ],
              usage: stepUsage
            };
            await exchangeSink?.onStepCompleted({
              exchangeId,
              purpose: input.purpose(),
              request,
              response,
              status: "completed",
              startedAt,
              endedAt: now().toISOString()
            });
            steps.push({ startedAt, request, response });
            messages.push(assistant, toolMessage);
            if (outcome.stop) {
              return { steps, usage };
            }
          }
          return { steps, usage };
        }
      };
    }
  };
}

/** A model that only ever goes back to sleep, for runs that are not about it. */
export function createSleepingModel(now?: () => Date): ModelClient {
  return createScriptedModel({
    ...(now ? { now } : {}),
    script: ({ step }) =>
      step === 0 ? { toolName: "sleep", input: { seconds: 3600 } } : undefined
  });
}
