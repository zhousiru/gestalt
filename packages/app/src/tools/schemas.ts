import { z } from "zod";
import { ConversationSchema } from "../events/schemas";

export const ToolNameSchema = z.enum(["look", "say", "react", "sleep", "bash"]);

const ActionProposalBaseSchema = z
  .object({
    id: z.string().min(1),
    proposedAt: z.string().min(1)
  })
  .strict();

export const LookActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("look"),
  params: z
    .object({
      place: z.string().min(1).optional(),
      before: z.string().min(1).optional(),
      search: z.string().min(1).max(200).optional(),
      image: z.string().min(1).max(4000).optional(),
      messageId: z.string().min(1).optional()
    })
    .strict()
});

export const SayActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("say"),
  params: z
    .object({
      conversation: ConversationSchema,
      text: z.string().min(1).max(2000).optional(),
      stickerId: z.string().min(1).max(200).optional(),
      replyTo: z.string().min(1).optional()
    })
    .strict()
});

export const ReactActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("react"),
  params: z
    .object({
      conversation: ConversationSchema,
      messageId: z.string().min(1),
      emoji: z.string().min(1)
    })
    .strict()
});

export const SleepActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("sleep"),
  params: z
    .object({
      seconds: z.number().finite().nonnegative(),
      note: z.string().min(1).max(2000).optional(),
      doNotDisturb: z.boolean().optional()
    })
    .strict()
});

export const BashActionProposalSchema = ActionProposalBaseSchema.extend({
  toolName: z.literal("bash"),
  params: z
    .object({
      command: z.string().min(1)
    })
    .strict()
});

export const ActionProposalSchema = z.discriminatedUnion("toolName", [
  LookActionProposalSchema,
  SayActionProposalSchema,
  ReactActionProposalSchema,
  SleepActionProposalSchema,
  BashActionProposalSchema
]);

export const ToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    purpose: z.string().min(1),
    whenUseful: z.array(z.string().min(1)),
    avoidWhen: z.array(z.string().min(1))
  })
  .strict();

export type ToolName = z.infer<typeof ToolNameSchema>;
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** Visible effects cross the durable outbound boundary before they execute. */
export function isVisibleSideEffect(proposal: ActionProposal): boolean {
  return proposal.toolName === "say" || proposal.toolName === "react";
}
