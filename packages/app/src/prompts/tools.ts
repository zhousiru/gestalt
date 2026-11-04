import type { ToolName } from "../tools/schemas";
import { hashPromptContent } from "./hash";

export interface ActionToolPrompt {
  purpose: string;
  whenUseful: readonly string[];
  avoidWhen: readonly string[];
  parameters: Readonly<Record<string, string>>;
}

export const ACTION_TOOL_PROMPTS = {
  look: {
    purpose: "Enter one place, and look around once you are there. Pass place to enter it. Each wake can only enter one place. Once inside, call look with no arguments for anything new, or with before, search, message_id, or image.",
    whenUseful: ["Something on your phone interests you.", "You want to read further back, find something someone said, or see an image."],
    avoidWhen: ["Nothing on your phone interests you. You do not have to open anything.", "You want a second place. Sleep first, even briefly."],
    parameters: {
      place: "Place id from your phone, or web, or dream.",
      before: "Message id; read the messages before it.",
      search: "Text to find in this place's chat history.",
      message_id: "Read one specific message.",
      image: "Image file id copied from [CQ:image,file=...] to actually see it."
    }
  },
  say: {
    purpose: "Send something to the place you are in. Give text, or a sticker_id, or both. Typing takes time: if new messages arrive before you finish, nothing is sent and you are shown them, so you can decide again.",
    whenUseful: ["You have something to say here."],
    avoidWhen: ["It would only repeat what was said.", "It is not your conversation and you have nothing to add."],
    parameters: {
      text: "Plain text as you would type it. No Markdown. CQ markup such as [CQ:at,qq=...] or [CQ:face,id=...] is allowed.",
      sticker_id: "Sticker id from `sticker search` in bash.",
      reply_to: "Message id to quote. Only when it would otherwise be unclear what you are answering."
    }
  },
  react: {
    purpose: "Put a small emoji on a message in the place you are in, without saying anything.",
    whenUseful: ["A tiny acknowledgement is all this deserves."],
    avoidWhen: ["Someone asked you something."],
    parameters: {
      message_id: "Message id to react to.",
      emoji: "One emoji name from the list."
    }
  },
  sleep: {
    purpose: "End this wake and go to sleep. This is how every wake ends. You decide how long. Someone calling you wakes you sooner, unless you set do_not_disturb.",
    whenUseful: ["You are done here, whether or not you did anything."],
    avoidWhen: ["You still mean to say or do something in this wake."],
    parameters: {
      seconds: "How long to sleep. Seconds to a minute or two if a conversation you are in is moving; tens of minutes to hours when nothing needs you.",
      note: "A line or two for your diary about this place: what happened, what you thought, what you might come back to. Skip it if nothing is worth keeping.",
      do_not_disturb: "True if being called should not wake you, as when you are really going to bed."
    }
  },
  bash: {
    purpose: "Run a shell command in this wake's private environment. Once you are in a place, agent-browser reaches the real web. In a chat, `sticker search <what you feel>` finds stickers.",
    whenUseful: ["You want to read something online, check your own files, or find a sticker."],
    avoidWhen: ["You are guessing at something you could just look up with look."],
    parameters: { command: "Bash command to run." }
  }
} satisfies Record<ToolName, ActionToolPrompt>;

export const INSPECT_TOOL_PROMPTS = {
  bash: {
    description: "Run one read-only bash command in a virtual filesystem. Mounted evidence: /sessions and /traces. Use this to inspect JSONL files before reporting.",
    parameters: { command: "Executable shell code for read-only inspection. Prefer ls, cat, head, tail, grep-like shell pipelines, and python/json parsing. Do not write files." }
  },
  send_inspect_report: {
    description: "Submit the final inspect diagnosis. This does not send directly to the chat platform; the runtime will send the report text after this tool is called.",
    parameters: { report: "Final diagnosis in plain text. Do not use Markdown formatting, bullet lists, tables, headings, code fences, or links." }
  }
} as const;

export function renderActionToolDescription(name: ToolName): string {
  const prompt = ACTION_TOOL_PROMPTS[name];
  return [
    prompt.purpose,
    `It may feel right when: ${prompt.whenUseful.join("; ")}`,
    `Hold back when: ${prompt.avoidWhen.join("; ")}`
  ].join("\n");
}

export function hashModelToolPrompts(toolNames: readonly ToolName[]): string {
  return hashPromptContent(
    toolNames
      .map((name) => JSON.stringify([name, ACTION_TOOL_PROMPTS[name]]))
      .join("\n")
  );
}
