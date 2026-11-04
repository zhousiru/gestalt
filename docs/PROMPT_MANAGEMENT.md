# Prompt Management

## Scope And Ownership

Model-visible fixed text has two owners:

- Runtime prompts live under `packages/app/src/prompts/`.
- Eval-only judge prompts and rubrics live under `harness/src/prompts/`.

The constitution, `me/`, place memory, diaries, transcripts, timestamps, and replay evidence are runtime data. They are rendered through typed functions but are not platform prompt policy.

## Runtime API

Runtime callers use explicit renderers such as:

```ts
const prompt = renderLifeSystemPrompt({ constitution, me });
```

Every renderer returns a `RenderedPrompt` with a stable semantic `id`, normalized
`content`, and an automatically derived `contentHash`. There is no manually
maintained prompt revision. Harness request artifacts retain the full provider
messages through their independent capture sink. Production rollout storage
records the initial prompt/tool protocol once, then committed message deltas and
state hashes; it never repeats the complete cumulative request per generation.

Tool descriptions and parameter descriptions live in `packages/app/src/prompts/tools.ts`. Tool schemas and execution remain in their owning runtime modules. The default tool registry is derived from the same catalog so model-visible tool copy has one source.

## No Conditional Policy Prompts

Fixed policy must not branch on runtime configuration or available tools. In particular:

- The life system prompt has one fixed policy path, for wakes and dreams alike.
- Every tool is always offered. A tool that cannot act right now, such as `say` with no place, explains why in its result.
- What differs between a wake and a dream is the opening message and the mounts.
- Unread messages, held messages, and search results use the same transcript renderer.

Dynamic data rendering is allowed. Empty `me/`, memory, or phones use deterministic placeholders rather than selecting another policy prompt. Each wake opening carries a minute-level current time and renders message timestamps in the GestaltHome `timezone`; this dynamic clock belongs in the opening rather than the stable system prompt, so the prompt cache survives from wake to wake. The runtime resolves an explicit IANA timezone first, then the machine timezone, then UTC, and traces the resolved value and source so replay remains inspectable.

## Change Workflow

When runtime prompt or tool copy changes:

1. Update the owning prompt module.
2. Update or add a durable scenario fixture if behavior changes.
3. Run `verify:prompts` and the narrow runtime verification.
4. Inspect `model-requests.json`, `model-exchanges.json`, reconstructed rollout
   inputs, and cache evidence.
5. Run the relevant real-model eval.
6. Run typecheck and build.

Eval rubric changes follow the same evidence workflow but remain isolated inside the harness prompt directory.
