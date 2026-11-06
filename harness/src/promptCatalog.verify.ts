import assert from "node:assert/strict";
import {
  ACTION_TOOL_PROMPTS,
  ToolNameSchema,
  createDefaultToolRegistry,
  hashModelToolPrompts,
  DEFAULT_CONSTITUTION,
  renderDreamPrompt,
  renderInspectSystemPrompt,
  renderLifeSystemPrompt,
  renderWakePrompt,
  renderInspectTaskPrompt,
  renderStickerDescriptionPrompt
} from "@gestalt/app";

const action = renderLifeSystemPrompt({
  constitution: DEFAULT_CONSTITUTION,
  me: []
});
assert.equal(action.id, "runtime.life.system");
assert.match(action.contentHash, /^[a-f0-9]{16}$/);
assert.match(action.content, /You are not an assistant on duty/);
assert.match(action.content, /There is one of you/);
assert.match(action.content, /Every wake ends with sleep/);
assert.match(action.content, /Reading and leaving is normal/);
assert.match(action.content, /You are an AI, and you do not hide it/);
assert.match(action.content, /You never invent experiences/);
assert.match(action.content, /agent-browser skills get core/);
assert.match(action.content, /Write plain text with no Markdown/);
assert.match(ACTION_TOOL_PROMPTS.say.parameters.text, /No Markdown/);
assert.equal(
  ACTION_TOOL_PROMPTS.bash.parameters.command,
  "Bash command to run."
);
assert.equal(
  action.contentHash,
  renderLifeSystemPrompt({ constitution: DEFAULT_CONSTITUTION, me: [] })
    .contentHash
);
assert.notEqual(
  action.contentHash,
  renderLifeSystemPrompt({
    constitution: DEFAULT_CONSTITUTION,
    me: [{ path: "me/index.md", content: "changed by a dream" }]
  }).contentHash
);

const wake = renderWakePrompt({
  time: "2026-11-05 14:20, Thursday (Asia/Shanghai)",
  sleptFor: "38 minutes",
  reason: "you meant to wake around now",
  budgetLeftPercent: 62,
  lastDream: "16 hours ago",
  phone: [
    { place: "group-1", kind: "group", name: "群", unread: 3, called: true }
  ],
  quietChats: ["group-2", "private-3"],
  web: "",
  emojis: ["赞"]
});
assert.equal(wake.id, "runtime.life.wake");
assert.match(wake.content, /3 unread, someone called you/);
assert.match(wake.content, /Quiet chats you can open: group-2, private-3/);

const dream = renderDreamPrompt({
  lastDream: "1 day ago",
  diaries: [],
  omittedDiaries: 0
});
assert.match(dream, /Ask what stayed with you/);
assert.match(dream, /What do you want to do next/);
assert.match(dream, /not facts about anyone else/);
assert.match(dream, /Keep the words if the words are the point/);
assert.doesNotMatch(dream, /Usually change nothing/);

assert.match(renderInspectSystemPrompt().content, /read-only bash tool/);
assert.match(
  renderInspectTaskPrompt({
    now: "2026-07-11T00:00:00.000Z",
    query: "",
    conversation: "group:test",
    eventId: "event-1",
    sessionRecordId: "record-1",
    messageId: "message-1",
    sender: "Alice (alice)",
    receivedAt: "2026-07-11T00:00:00.000Z",
    text: "/inspect",
    conversationSummary: "(conversation not found in current diagnostics)"
  }).content,
  /\(no explicit inspect query;/
);

const names = ToolNameSchema.options;
assert.deepEqual(Object.keys(ACTION_TOOL_PROMPTS), names);
assert.deepEqual(
  createDefaultToolRegistry().map((tool) => tool.name),
  names
);
assert.match(hashModelToolPrompts(names), /^[a-f0-9]{16}$/);

const staticStickerPrompt = renderStickerDescriptionPrompt({
  animated: false,
  frameCount: 1
});
const animatedStickerPrompt = renderStickerDescriptionPrompt({
  animated: true,
  frameCount: 20,
  platformSummary: "[动画表情]"
});
assert.equal(staticStickerPrompt.id, "sticker-description");
assert.match(staticStickerPrompt.content, /requested structured fields/);
assert.match(staticStickerPrompt.content, /visual: Write in English/);
assert.match(staticStickerPrompt.content, /Describe only objectively visible content/);
assert.match(staticStickerPrompt.content, /Do not infer emotion, intent/);
assert.match(staticStickerPrompt.content, /happy, excited, smug/);
assert.match(staticStickerPrompt.content, /usage: Return 10 to 20 distinct/);
assert.match(staticStickerPrompt.content, /short Chinese IM messages/);
assert.match(staticStickerPrompt.content, /not explanations of when to use them/);
assert.match(staticStickerPrompt.content, /one static sticker image/);
assert.doesNotMatch(staticStickerPrompt.content, /4x4 contact sheet/);
assert.match(animatedStickerPrompt.content, /4x4 contact sheet/);
assert.match(animatedStickerPrompt.content, /sampled evenly/);
assert.match(animatedStickerPrompt.content, /20 source frames/);
assert.match(animatedStickerPrompt.content, /left-to-right, top-to-bottom/);
assert.match(animatedStickerPrompt.content, /Infer the most likely complete motion or action/);
assert.match(animatedStickerPrompt.content, /one coherent action/);
assert.match(animatedStickerPrompt.content, /only a hint/);
assert.notEqual(animatedStickerPrompt.hash, staticStickerPrompt.hash);
assert.equal(
  animatedStickerPrompt.hash,
  renderStickerDescriptionPrompt({
    animated: true,
    frameCount: 20,
    platformSummary: "[动画表情]"
  }).hash
);
assert.match(animatedStickerPrompt.hash, /^[a-f0-9]{16}$/);

console.log(
  JSON.stringify({
    ok: true,
    actionPrompt: { id: action.id, contentHash: action.contentHash },
    wakePrompt: { id: wake.id, contentHash: wake.contentHash },
    stickerPrompt: {
      id: animatedStickerPrompt.id,
      hash: animatedStickerPrompt.hash
    },
    tools: names.length,
    toolPromptHash: hashModelToolPrompts(names)
  }, null, 2)
);
