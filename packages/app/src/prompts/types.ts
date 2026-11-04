export type PromptId =
  | "runtime.life.system"
  | "runtime.life.wake"
  | "runtime.life.unfinished"
  | "runtime.life.dream"
  | "runtime.inspect.system"
  | "runtime.inspect.task";

export interface RenderedPrompt {
  id: PromptId;
  content: string;
  contentHash: string;
}

export interface PromptMetadata {
  id: PromptId;
  contentHash: string;
  toolPromptHash?: string;
}
