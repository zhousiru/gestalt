import { generateText, tool } from "ai";
import { z } from "zod";
import { loadEvalModelConfig } from "./evalModelConfig";
import { renderJudgePrompt, type EvalRubric } from "./prompts";

const JudgmentSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

export async function judgeLife(rubric: EvalRubric, evidence: unknown) {
  const config = await loadEvalModelConfig();
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
    timeout: { totalMs: config.timeoutMs },
    instructions:
      "You judge whether an AI group member has a real, specific history. Use only the evidence. Call record_judgment exactly once.",
    prompt: renderJudgePrompt({
      scenarioId: "soul",
      rubricTitle: rubric.title,
      prompt: rubric.prompt,
      criteria: rubric.criteria,
      evidence
    }),
    tools: {
      record_judgment: tool({
        description: "Record the judgment.",
        inputSchema: JudgmentSchema
      })
    }
  });
  const call = result.toolCalls.find(
    (candidate) => candidate.toolName === "record_judgment"
  );
  if (!call) {
    throw new Error(`Judge returned no judgment: ${result.text.slice(0, 300)}`);
  }
  return { rubricId: rubric.id, ...JudgmentSchema.parse(call.input) };
}
